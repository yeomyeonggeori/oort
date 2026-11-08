import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import type { Browser, Page } from "playwright";
import { ENGINES, type EngineName } from "@/design/appearance/compileTokensTestKit";

// =============================================================================
// 세트 카드 격자가 카드 폭을 따르는가, 한국어가 낱말 중간에서 꺾이지 않는가 (#5527, 검수 7c M2·M1)
//
// M2: 격자가 4열 고정이라 데스크탑 최소 창(720)의 카드(안쪽 약 270)에서 칸이 약 60px가 되어 그림 자리(64 고정)가 칸을 넘고 왼쪽 위 체크 상자가 그림을 덮었다.
// 고침: 열 수가 카드 폭을 따르고(`setGridColumns`, 칸의 가장 좁은 폭 108) 줄의 모양과 키보드 칸 이동(위·아래)이 같은 값을 쓰며, 그림 자리는 칸이 좁으면 칸 폭에 맞춘다.
// M1: 두 카드의 한국어에 `break-keep`이 없어 「했/어요」처럼 낱말 중간에서 꺾였다.
//
// 이 시험은 **실제 엔진의 계산된 상자**를 잰다: 눈에 보이는 열 수(첫 줄 칸들의 서로 다른 왼쪽 위치), 그림 자리와 체크 상자의 겹침, 방향키가 건너뛰는 칸 수, 계산된 `word-break`,
// 그리고 한국어 낱말(공백으로 가른 덩어리)이 두 줄에 걸쳐 그려지는지(Range 의 줄 조각 수). 사보타주: `setGridColumns` 가 늘 4를 돌려주면 열 수·겹침 시험이 붉고,
// 카드 뿌리의 `break-keep` 을 지우면 M1 시험이 붉다.
// 엔진은 `ENGINES`(설치된 WebKit·Chromium 전부)다. 하나도 없으면 건너뛴다(다른 브라우저 시험과 같은 규약).
// =============================================================================

type Rig = { engine: EngineName; browser: Browser; origin: string };
const rigs: Rig[] = [];
let server: ViteDevServer | null = null;
let cacheDir = "";

beforeAll(async () => {
  if (ENGINES.length === 0) return;
  cacheDir = mkdtempSync(join(tmpdir(), "oort-expression-set-fit-vite-"));
  server = await createServer({
    cacheDir,
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
    plugins: [{ name: "expression-set-fit-fixture", configureServer(vite) {
      vite.middlewares.use("/__expression-set-fit", async (_req, res) => {
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml("/__expression-set-fit", `<!doctype html><html lang="ko"><head><style>
          html,body{margin:0}#root{margin:24px}
          </style></head><body><div id="root"></div><script type="module">import {mountExpressionSetCardFitHarness} from '/measure/expressionSetCardFit.harness.tsx';mountExpressionSetCardFitHarness();</script></body></html>`));
      });
    } }],
  });
  await server.listen();
  console.info(`expression set card fit: real engines = ${ENGINES.join(", ")}`);
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

/** 카드 바깥 상자 = 안쪽 폭 + 테두리 2 + 안여백 24. */
const outerFor = (inner: number) => inner + 26;
const TILE = '[data-testid="expression-set-tile"]';

async function openCard(rig: Rig, inner: number, query = "card=set&fixture=normal"): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const context = await rig.browser.newContext({ viewport: { width: 1000, height: 1400 }, locale: "ko-KR", reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/v1/**", (route) => route.fulfill({ status: 404, body: "" }));
  await page.goto(`${rig.origin}/__expression-set-fit?${query}&w=${outerFor(inner)}`);
  await page.locator('[data-testid="expression-set"], [data-testid="expression-plan"]').first().waitFor();
  await page.waitForFunction(() => document.fonts.status === "loaded");
  // 첫 그림 전에 폭을 한 번 재므로 열 수는 곧 서 있다. 그림(칸 안의 img)이 다 그려질 때까지 기다린다.
  if (query.startsWith("card=set")) await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="expression-set-tile"] img')].every((image) => (image as HTMLImageElement).complete));
  await page.waitForTimeout(250);
  return { page, errors, close: () => context.close() };
}

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };
type Probe = {
  cols: string[]; rowCount: number; firstRowTiles: number; visibleColumns: number; gridOverflowsX: boolean;
  tiles: Array<{ tile: Box; picture: Box; image: Box | null; check: Box | null }>;
};

const probe = (page: Page): Promise<Probe> => page.evaluate(() => {
  const box = (el: Element | null) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height };
  };
  const grid = document.querySelector<HTMLElement>('[data-testid="expression-set-grid"]')!;
  const rows = [...grid.querySelectorAll<HTMLElement>('[role="row"]')];
  const firstRow = rows[0]!;
  const firstRowTiles = [...firstRow.querySelectorAll('[data-testid="expression-set-tile"]')];
  return {
    cols: [...new Set(rows.map((row) => row.getAttribute("data-cols") ?? ""))],
    rowCount: rows.length,
    firstRowTiles: firstRowTiles.length,
    // 눈에 보이는 열 수: 첫 줄 칸들이 서로 다른 왼쪽 위치를 몇 개나 갖는가.
    visibleColumns: new Set(firstRowTiles.map((tile) => Math.round(tile.getBoundingClientRect().left))).size,
    gridOverflowsX: grid.scrollWidth > grid.clientWidth,
    tiles: [...grid.querySelectorAll('[data-testid="expression-set-tile"]')].map((tile) => ({
      tile: box(tile)!, picture: box(tile.querySelector(".expression-set-picture"))!, image: box(tile.querySelector(".expression-set-picture img")), check: box(tile.querySelector(".expression-set-check")),
    })),
  };
});

const intersects = (a: Box, b: Box) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
const activeIndex = (page: Page) => page.evaluate(() => [...document.querySelectorAll('[data-testid="expression-set-tile"]')].indexOf(document.activeElement as Element));

// 카드 안쪽 폭 → 기대하는 열 수. 720 창의 카드(약 270)가 2열인 것이 이 이슈의 값이고, 나머지는 칸의 가장 좁은 폭(108)에서 나온 문턱(340·456)이다.
const WIDTHS: Array<{ inner: number; columns: number; at: string }> = [
  { inner: 272, columns: 2, at: "720 창의 카드" },
  { inner: 340, columns: 3, at: "3열 문턱" },
  { inner: 456, columns: 4, at: "4열 문턱" },
  { inner: 700, columns: 4, at: "넓은 카드" },
];

describe("세트 카드 격자는 카드 폭을 따른다 (#5527 M2)", () => {
  it.skipIf(ENGINES.length === 0)("보이는 열 수가 폭을 따르고, 그림이 칸을 넘지 않고, 체크 상자가 그림을 덮지 않는다", async () => {
    for (const rig of rigs) {
      for (const { inner, columns, at } of WIDTHS) {
        const { page, errors, close } = await openCard(rig, inner);
        try {
          const found = await probe(page);
          const where = `[${rig.engine}] ${at}(안쪽 ${inner})`;
          expect(found.cols, `${where}: 줄의 data-cols`).toEqual([String(columns)]);
          expect(found.visibleColumns, `${where}: 눈에 보이는 열 수`).toBe(columns);
          expect(found.firstRowTiles, `${where}: 첫 줄 칸 수`).toBe(columns);
          expect(found.rowCount, `${where}: 줄 수`).toBe(Math.ceil(10 / columns));
          expect(found.gridOverflowsX, `${where}: 격자가 가로로 넘치지 않는다`).toBe(false);
          for (const [at_, cell] of found.tiles.entries()) {
            const name = `${where} 칸 ${at_}`;
            // 그림 자리는 칸의 테두리(2) 안쪽이고, 그림은 자리 안쪽이다.
            expect(cell.picture.left, `${name}: 그림 자리 왼쪽`).toBeGreaterThanOrEqual(cell.tile.left + 2);
            expect(cell.picture.right, `${name}: 그림 자리 오른쪽`).toBeLessThanOrEqual(cell.tile.right - 2);
            expect(Math.abs(cell.picture.width - cell.picture.height), `${name}: 그림 자리는 정사각`).toBeLessThanOrEqual(0.5);
            if (cell.image) {
              expect(cell.image.left, `${name}: 그림 왼쪽`).toBeGreaterThanOrEqual(cell.picture.left - 0.5);
              expect(cell.image.right, `${name}: 그림 오른쪽`).toBeLessThanOrEqual(cell.picture.right + 0.5);
            }
            // 체크 상자는 그림을 덮지 않는다(준비된 칸에만 있다).
            if (cell.check) expect(intersects(cell.check, cell.picture), `${name}: 체크 상자가 그림 자리와 겹친다`).toBe(false);
          }
          expect(found.tiles.filter((cell) => cell.check).length, `${where}: 준비된 칸에는 체크 상자가 있다`).toBe(10);
          expect(errors, `${where}: 페이지 오류`).toEqual([]);
        } finally { await close(); }
      }
    }
  }, 240_000);

  it.skipIf(ENGINES.length === 0)("방향키 위·아래가 눈에 보이는 열 수만큼 건너뛴다(좌우는 한 칸)", async () => {
    for (const rig of rigs) {
      for (const { inner, columns, at } of WIDTHS) {
        const { page, close } = await openCard(rig, inner);
        try {
          const where = `[${rig.engine}] ${at}(안쪽 ${inner}, ${columns}열)`;
          await page.locator(TILE).first().focus();
          await page.keyboard.press("ArrowDown");
          expect(await activeIndex(page), `${where}: 아래`).toBe(columns);
          await page.keyboard.press("ArrowRight");
          expect(await activeIndex(page), `${where}: 오른쪽`).toBe(columns + 1);
          await page.keyboard.press("ArrowUp");
          expect(await activeIndex(page), `${where}: 위`).toBe(1);
          await page.keyboard.press("ArrowLeft");
          expect(await activeIndex(page), `${where}: 왼쪽`).toBe(0);
        } finally { await close(); }
      }
    }
  }, 240_000);

  it.skipIf(ENGINES.length === 0)("창이 바뀌어 열 수가 달라져도 초점을 쥔 칸이 그대로이고 다음 방향키가 새 열 수를 쓴다", async () => {
    for (const rig of rigs) {
      const { page, close } = await openCard(rig, 456);
      try {
        const where = `[${rig.engine}]`;
        await page.locator(TILE).nth(5).focus();
        await page.evaluate((px) => (window as unknown as { cardFit: { setWidth: (px: number) => void } }).cardFit.setWidth(px), outerFor(272));
        await page.waitForFunction(() => document.querySelector('[role="row"]')?.getAttribute("data-cols") === "2");
        expect(await page.evaluate(() => document.activeElement?.getAttribute("data-index") ?? null), `${where}: 4열에서 2열로 줄어도 초점이 그 칸에 있다`).toBe("5");
        await page.keyboard.press("ArrowDown");
        expect(await activeIndex(page), `${where}: 새 열 수(2)만큼 건넌다`).toBe(7);
        // 다시 넓어지면 4열로 돌아가고, 그때도 초점은 그 칸이다.
        await page.evaluate((px) => (window as unknown as { cardFit: { setWidth: (px: number) => void } }).cardFit.setWidth(px), outerFor(520));
        await page.waitForFunction(() => document.querySelector('[role="row"]')?.getAttribute("data-cols") === "4");
        expect(await activeIndex(page), `${where}: 2열에서 4열로 늘어도 초점이 그 칸에 있다`).toBe(7);
        await page.keyboard.press("ArrowUp");
        expect(await activeIndex(page), `${where}: 4열 기준으로 위`).toBe(3);
      } finally { await close(); }
    }
  }, 180_000);

  it.skipIf(ENGINES.length === 0)("칸이 그림 자리(64)보다 좁아지면 그림 자리가 칸 폭에 맞춰 줄어든다", async () => {
    for (const rig of rigs) {
      const { page, close } = await openCard(rig, 80);
      try {
        const found = await probe(page);
        const where = `[${rig.engine}] 안쪽 80`;
        expect(found.cols, `${where}: 1열`).toEqual(["1"]);
        for (const [at_, cell] of found.tiles.entries()) {
          const content = cell.tile.width - 2 * 2 - 2 * 8;
          expect(content, `${where} 칸 ${at_}: 칸 안쪽이 그림 자리 64보다 좁다`).toBeLessThan(64);
          expect(cell.picture.width, `${where} 칸 ${at_}: 그림 자리가 칸 안쪽 폭을 따른다`).toBeLessThanOrEqual(content + 0.5);
          expect(cell.picture.right, `${where} 칸 ${at_}: 그림 자리가 칸을 넘지 않는다`).toBeLessThanOrEqual(cell.tile.right - 2);
        }
      } finally { await close(); }
    }
  }, 120_000);
});

type Wrap = { koreanElements: number; notKeepAll: string[]; brokenWords: string[] };

/** 카드 안의 한국어 글 줄: 계산된 `word-break` 가 모두 keep-all 인가, 낱말(공백으로 가른 덩어리)이 두 줄에 걸쳐 그려지는 곳이 있는가. */
const wrapOf = (page: Page, testId: string): Promise<Wrap> => page.evaluate((id) => {
  const card = document.querySelector(`[data-testid="${id}"]`)!;
  const notKeepAll: string[] = [];
  const brokenWords: string[] = [];
  const seen = new Set<Element>();
  const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    if (!/[가-힣]/.test(text)) continue;
    const owner = node.parentElement!;
    if (!seen.has(owner)) { seen.add(owner); if (getComputedStyle(owner).wordBreak !== "keep-all") notKeepAll.push(`${owner.tagName.toLowerCase()}: ${text.trim().slice(0, 24)}`); }
    for (const word of text.matchAll(/\S+/g)) {
      if (!/[가-힣]/.test(word[0])) continue;
      const range = document.createRange();
      range.setStart(node, word.index!);
      range.setEnd(node, word.index! + word[0].length);
      const lines = new Set([...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top)));
      if (lines.size > 1) brokenWords.push(word[0]);
    }
  }
  return { koreanElements: seen.size, notKeepAll, brokenWords };
}, testId);

describe("두 카드의 한국어는 낱말 중간에서 꺾이지 않는다 (#5527 M1)", () => {
  it.skipIf(ENGINES.length === 0)("세트 카드(정상·회색 칸 있음)는 좁은 카드(안쪽 272)에서도 낱말이 한 줄에 그려지고 word-break 가 keep-all 이다", async () => {
    for (const rig of rigs) {
      for (const fixture of ["normal", "refused"]) {
        const { page, close } = await openCard(rig, 272, `card=set&fixture=${fixture}`);
        try {
          const found = await wrapOf(page, "expression-set");
          const where = `[${rig.engine}] 세트 카드(${fixture})`;
          expect(found.koreanElements, `${where}: 한국어 글 줄이 있다`).toBeGreaterThan(8);
          expect.soft(found.notKeepAll, `${where}: word-break 가 keep-all 이 아닌 줄`).toEqual([]);
          expect.soft(found.brokenWords, `${where}: 두 줄에 걸쳐 그려진 낱말`).toEqual([]);
        } finally { await close(); }
      }
    }
  }, 180_000);

  it.skipIf(ENGINES.length === 0)("계획 카드는 좁은 카드(안쪽 272)에서도 낱말이 한 줄에 그려지고 word-break 가 keep-all 이다", async () => {
    for (const rig of rigs) {
      const { page, close } = await openCard(rig, 272, "card=plan");
      try {
        const found = await wrapOf(page, "expression-plan");
        const where = `[${rig.engine}] 계획 카드`;
        expect(found.koreanElements, `${where}: 한국어 글 줄이 있다`).toBeGreaterThan(8);
        expect.soft(found.notKeepAll, `${where}: word-break 가 keep-all 이 아닌 줄`).toEqual([]);
        expect.soft(found.brokenWords, `${where}: 두 줄에 걸쳐 그려진 낱말`).toEqual([]);
      } finally { await close(); }
    }
  }, 120_000);
});
