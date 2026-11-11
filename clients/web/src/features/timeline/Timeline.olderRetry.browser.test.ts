import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browserLaunchBlocked } from "@/testing/agentSandbox";

/**
 * 옛 쪽 읽기가 실패한 뒤에도, 진입 직후 이미 맨 위에 닿아 있어도 옛 글을 다시 읽는다(#5662, #5641 검수 K2).
 *
 * 가상 목록(react-virtuoso 4.18)의 `startReached` 는 「첫 줄의 번호」가 바뀔 때만 다시 나간다(같은 번호는 한 번만). 번호는
 * 옛 쪽이 앞에 붙어야 바뀌므로 (가) 옛 쪽 읽기가 한 번 실패하면 그 대화에서 다시는 나가지 않았고, (나) 머리말 한 줄뿐인 빈 대화에서
 * 이미 한 번 나간 번호를 다음 대화가 같은 목록 인스턴스에서 물려받으면(첫 쪽이 한 프레임 안에 와 로딩 뼈대가 서지 않을 때) 그
 * 대화에서는 맨 위에 닿아도 나가지 않았다. 이 시험은 실제 `Timeline` + `useTimeline` 을 `ChatShell` 과 같은 선으로 이은
 * 시험대(`timelineOlder.harness.tsx`)를 엔진(설치된 Chromium · WebKit) × 폭(1280 · 900 · 390)에서 띄워 옛 쪽 읽기 요청을 센다.
 *
 * 셈은 시험대의 가짜 서버가 받은 `before=` 요청이다(화면이 아니라 망에 나간 것). 엔진이 없으면 경고를 남기고 건너뛴다(다른 브라우저
 * 시험과 같은 규약) — 건너뛴 칸은 통과가 아니다.
 */

const require_ = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(HERE, "../../..");
const SRC = join(WEB_ROOT, "src");
const CORE_SRC = join(WEB_ROOT, "../../packages/momo-core/src");
const HARNESS = join(HERE, "timelineOlder.harness.tsx");

type EngineName = "chromium" | "webkit";
type ChannelName = "general" | "long" | "short";
type OlderRequest = { at: number; channel: ChannelName; before: number; outcome: "ok" | "failed" | "pending" };

function engineMissing(name: EngineName): string | null {
  const blocked = browserLaunchBlocked();
  if (blocked !== null) return blocked;
  try {
    const playwright = require_("playwright") as typeof import("playwright");
    const exe = playwright[name].executablePath();
    return existsSync(exe) ? null : exe;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const ENGINES: EngineName[] = (["chromium", "webkit"] as const).filter((name) => {
  const missing = engineMissing(name);
  if (missing !== null) console.warn(`older-retry browser test: Playwright ${name} missing (${missing})`);
  return missing === null;
});

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 900, height: 800 },
  { width: 390, height: 844 },
] as const;

function quotedClassTokens(source: string): string[] {
  const tokens: string[] = [];
  for (const match of source.matchAll(/["'`]([^"'`]+)["'`]/g)) {
    const chunk = match[1];
    if (chunk.includes("/") || chunk.includes("://") || chunk.includes(".tsx")) continue;
    for (const tok of chunk.split(/\s+/)) {
      if (tok && /^[A-Za-z0-9_:[\]/%.-]+$/.test(tok) && /[a-z]/.test(tok)) tokens.push(tok);
    }
  }
  return tokens;
}

async function buildAssets(): Promise<{ js: string; css: string }> {
  const esbuild = await import("esbuild");
  const bundled = await esbuild.build({
    absWorkingDir: WEB_ROOT,
    entryPoints: [HARNESS],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    alias: { "@": SRC, "@momo/core": CORE_SRC },
    define: {
      "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "test", SSR: false }),
      "import.meta.url": JSON.stringify("https://example.test/timeline-older-harness.js"),
    },
    logLevel: "silent",
  });
  const js = bundled.outputFiles[0]?.text;
  if (!js) throw new Error("esbuild produced no timeline older harness");
  const tokensPath = join(HERE, "../../design/tokens.css");
  const compiler = await compile(readFileSync(tokensPath, "utf8"), {
    base: dirname(tokensPath),
    loadStylesheet: async (id: string, base: string) => {
      const path =
        id === "tailwindcss" || id.endsWith("tailwindcss/index.css")
          ? require_.resolve("tailwindcss/index.css")
          : id.startsWith(".") || id.startsWith("/")
            ? `${base}/${id}`
            : id;
      return { path, base: dirname(path), content: readFileSync(path, "utf8") };
    },
  });
  const sources = ["Timeline.tsx", "MessageRow.tsx", "ChannelIntroBlock.tsx", "../common/States.tsx"];
  const css = compiler.build([
    ...new Set([
      "h-full",
      "relative",
      "timeline-scroller",
      // 실패 줄의 자리(떠 있는 한 줄). 따옴표 짝으로 읽는 아래 추출은 주석의 백틱과 어긋나 이 클래스들을 놓칠 수 있다 — 놓치면 줄이
      // 흐름 안에 서서 목록을 밀고, 보던 줄 이동 단정이 시험대 탓으로 깨진다.
      "layer-content-float",
      "absolute",
      "inset-x-0",
      "top-0",
      "bg-pane",
      ...sources.flatMap((file) => quotedClassTokens(readFileSync(join(HERE, file), "utf8"))),
    ]),
  ]);
  return { js, css };
}

let assets: { js: string; css: string } | null = null;
const browsers = new Map<EngineName, Browser>();

beforeAll(async () => {
  if (ENGINES.length === 0) return;
  assets = await buildAssets();
  const playwright = await import("playwright");
  for (const name of ENGINES) browsers.set(name, await playwright[name].launch());
}, 120_000);

afterAll(async () => {
  for (const browser of browsers.values()) await browser.close();
  browsers.clear();
});

const SCROLLER = "[data-testid='timeline-virtuoso']";

async function openHarness(
  engine: EngineName,
  viewport: { width: number; height: number },
  start: ChannelName,
  batchEntry = false
): Promise<{ page: Page; close: () => Promise<void>; errors: string[] }> {
  const browser = browsers.get(engine);
  if (!browser || !assets) throw new Error(`${engine} not launched`);
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: "ko-KR" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err instanceof Error ? err.message : String(err)));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setContent(
    `<!doctype html><html><head><style>
html, body, #root { height: 100%; margin: 0; }
${assets.css}
</style></head><body><div id="root"></div>
<script>
(() => {
  const memory = () => {
    const store = new Map();
    return {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(String(key), String(value)); },
      removeItem: (key) => { store.delete(String(key)); },
      clear: () => { store.clear(); },
      key: (index) => [...store.keys()][index] ?? null,
      get length() { return store.size; },
    };
  };
  Object.defineProperty(window, "localStorage", { value: memory() });
  Object.defineProperty(window, "sessionStorage", { value: memory() });
  window.matchMedia = (query) => ({
    matches: false, media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent() { return false; },
  });
  window.__timelineOlderStart = ${JSON.stringify(start)};
  window.__timelineOlderBatchEntry = ${JSON.stringify(batchEntry)};
})();
</script>
<script>${assets.js}</script>
</body></html>`,
    { waitUntil: "domcontentloaded" }
  );
  await page.waitForFunction(() => Boolean(window.__timelineOlder), undefined, { timeout: 10_000 });
  return { page, errors, close: () => context.close() };
}

const requests = (page: Page): Promise<OlderRequest[]> => page.evaluate(() => window.__timelineOlder.requests());

/**
 * 목록이 바닥에 앉을 때까지(세 프레임 연달아 바닥 · 줄이 섬) + 진입 수렴이 끝날 600ms. 진입 직후 몇백 ms 동안은 목록이 스스로 바닥으로
 * 돌아가므로(사람이 그 사이 맨 위까지 올리지는 않는다) 그 뒤에 움직인다. 앉지 못하면 시험 시간 초과로 실패한다.
 */
async function settleBottom(page: Page, minRows: number): Promise<void> {
  await page.waitForFunction(
    ({ selector, rows }) => {
      const scroller = document.querySelector(selector);
      if (!(scroller instanceof HTMLElement)) return false;
      const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      const ok = scroller.querySelectorAll("[data-testid='timeline-message']").length >= rows && gap <= 4;
      const w = window as unknown as { __settleStreak?: number };
      w.__settleStreak = ok ? (w.__settleStreak ?? 0) + 1 : 0;
      return w.__settleStreak >= 3;
    },
    { selector: SCROLLER, rows: minRows },
    { timeout: 10_000, polling: "raf" }
  );
  await page.waitForTimeout(600);
}

const setTop = (page: Page, value: number) =>
  page.evaluate(
    ({ selector, value: top }) => {
      const scroller = document.querySelector(selector);
      if (scroller instanceof HTMLElement) scroller.scrollTop = top;
    },
    { selector: SCROLLER, value }
  );

const wait = (page: Page, ms: number) => page.waitForTimeout(ms);

/** 「long 251」 줄(옛 쪽이 붙기 전 맨 위 줄)의 화면 위치(px, 창 기준 — 스크롤러째 밀려도 잡는다). 없으면 null. */
const rowTop = (page: Page): Promise<number | null> =>
  page.evaluate((selector) => {
    const scroller = document.querySelector(selector);
    if (!(scroller instanceof HTMLElement)) return null;
    for (const item of scroller.querySelectorAll("[data-index]")) {
      if ((item.textContent ?? "").includes("long 251")) {
        return item.getBoundingClientRect().top;
      }
    }
    return null;
  }, SCROLLER);

/** 옛 쪽 요청이 `count` 개가 되고 마지막 것이 끝날 때까지(최대 `ms`). 넘으면 그대로 돌려준다 — 단정은 부른 쪽이 한다. */
async function waitRequests(page: Page, count: number, ms: number): Promise<OlderRequest[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const list = await requests(page);
    if (list.length >= count && list.every((entry) => entry.outcome !== "pending")) return list;
    if (Date.now() > deadline) return list;
    await wait(page, 50);
  }
}

const cells = ENGINES.flatMap((engine) => VIEWPORTS.map((viewport) => ({ engine, viewport })));
const label = (cell: (typeof cells)[number]) => `${cell.engine} ${cell.viewport.width}`;

describe.skipIf(ENGINES.length === 0)("옛 쪽 읽기 — 실패 뒤 · 진입 직후 맨 위 (#5662)", () => {
  // 지키는 것 (가): 옛 쪽 읽기가 망 오류로 한 번 실패한 뒤 내렸다가 다시 맨 위에 닿으면 다시 읽는다 — 닿을 때 한 번.
  it.each(cells)("(가) 실패 뒤 다시 맨 위에 닿으면 다시 읽는다 — $engine $viewport.width", async (cell) => {
    const { page, close, errors } = await openHarness(cell.engine, cell.viewport, "long");
    try {
      await settleBottom(page, 10);
      await page.evaluate(() => window.__timelineOlder.failNextOlder(1));
      await setTop(page, 0);
      const first = await waitRequests(page, 1, 3_000);
      expect(first.map((entry) => entry.outcome), `${label(cell)} 첫 읽기`).toEqual(["failed"]);
      // 실패를 말한다: 목록 위 한 줄과 「다시 시도」(단정은 다시 닿기를 잰 뒤 — 읽기 수가 먼저다).
      const lineShown = await page
        .getByTestId("timeline-older-error")
        .waitFor({ state: "visible", timeout: 1_000 })
        .then(() => true, () => false);
      const topWithLine = await rowTop(page);
      // 연속 실패 간격(첫 실패 뒤 1초)을 넘긴 뒤 사람이 조금 내렸다가 다시 올린다.
      await wait(page, 1_100);
      await setTop(page, 1_500);
      await wait(page, 400);
      await setTop(page, 0);
      await waitRequests(page, 2, 3_000);
      await wait(page, 600);
      const settled = await requests(page);
      expect(settled.length, `${label(cell)} 다시 닿은 뒤 읽기 수`).toBeGreaterThanOrEqual(2);
      expect(settled[1]?.outcome, `${label(cell)} 둘째 읽기`).toBe("ok");
      // 닿을 때 한 번: 둘째 읽기가 붙은 뒤 셋째가 겹쳐 나가지 않는다(붙은 쪽이 보던 자리를 맨 위에서 떼어 놓는다).
      expect(settled.length, `${label(cell)} 읽기 총수`).toBe(2);
      expect(lineShown, `${label(cell)} 실패 줄`).toBe(true);
      await page.getByTestId("timeline-older-error").waitFor({ state: "detached", timeout: 2_000 });
      // 실패 줄이 뜨고 진 것 · 옛 쪽이 붙은 것으로 보던 줄이 밀리지 않는다(떠 있는 한 줄 + 앞붙이기 보정, ≤ 2px).
      const topAfter = await rowTop(page);
      expect(topWithLine, `${label(cell)} 실패 줄이 선 동안 보던 줄`).not.toBeNull();
      expect(Math.abs((topAfter ?? Number.NaN) - (topWithLine ?? Number.NaN)), `${label(cell)} 보던 줄 이동 px`).toBeLessThanOrEqual(2);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 30_000);

  // 지키는 것 (나): 빈 대화(머리말 한 줄)에 머문 뒤 첫 쪽이 한 프레임 안에 오는 긴 대화로 가면, 그 대화의 맨 위에서도 읽는다.
  it.each(cells)("(나) 빈 대화 → 긴 대화: 맨 위에 닿으면 읽는다 — $engine $viewport.width", async (cell) => {
    const { page, close, errors } = await openHarness(cell.engine, cell.viewport, "general", true);
    try {
      await page.locator(`${SCROLLER} [data-index]`).first().waitFor({ state: "attached", timeout: 5_000 });
      await wait(page, 400);
      await page.evaluate(() => window.__timelineOlder.open("long"));
      await settleBottom(page, 10);
      expect(await requests(page), `${label(cell)} 진입 중 읽기`).toEqual([]);
      await setTop(page, 0);
      const list = await waitRequests(page, 1, 3_000);
      await wait(page, 600);
      expect(list.length, `${label(cell)} 맨 위에서 읽기 수`).toBe(1);
      expect((await requests(page)).length, `${label(cell)} 읽기 총수`).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 30_000);

  // 지키는 것 (나'): 빈 대화 뒤에 연 대화가 진입 직후 이미 맨 위에 닿아 있으면(첫 쪽이 짧고 더 옛 글이 있음) 스크롤 없이 읽는다.
  it.each(cells)("(나') 빈 대화 → 짧은 대화: 진입 직후 맨 위면 스스로 읽는다 — $engine $viewport.width", async (cell) => {
    const { page, close, errors } = await openHarness(cell.engine, cell.viewport, "general", true);
    try {
      await page.locator(`${SCROLLER} [data-index]`).first().waitFor({ state: "attached", timeout: 5_000 });
      await wait(page, 400);
      await page.evaluate(() => window.__timelineOlder.open("short"));
      const list = await waitRequests(page, 1, 3_000);
      expect(list.length, `${label(cell)} 진입 뒤 읽기 수`).toBeGreaterThanOrEqual(1);
      expect(list[0]?.channel).toBe("short");
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 30_000);

  // 지키는 것: 긴 대화에 들어가는 동안(바닥으로 가는 첫 몇 프레임에 맨 위가 잠깐 보여도) 옛 쪽을 읽지 않는다 — 곧장 들어가도, 빈 대화를 거쳐도.
  it.each(cells)("긴 대화 진입은 옛 쪽을 읽지 않는다 — $engine $viewport.width", async (cell) => {
    const direct = await openHarness(cell.engine, cell.viewport, "long");
    try {
      await settleBottom(direct.page, 10);
      await wait(direct.page, 400);
      expect(await requests(direct.page), `${label(cell)} 곧장`).toEqual([]);
    } finally {
      await direct.close();
    }
    const via = await openHarness(cell.engine, cell.viewport, "general", true);
    try {
      await via.page.locator(`${SCROLLER} [data-index]`).first().waitFor({ state: "attached", timeout: 5_000 });
      await wait(via.page, 400);
      await via.page.evaluate(() => window.__timelineOlder.open("long"));
      await settleBottom(via.page, 10);
      await wait(via.page, 400);
      expect(await requests(via.page), `${label(cell)} 빈 대화를 거쳐`).toEqual([]);
    } finally {
      await via.close();
    }
  }, 30_000);
});
