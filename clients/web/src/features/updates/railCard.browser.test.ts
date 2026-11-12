import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browserLaunchBlocked } from "@/testing/agentSandbox";

/**
 * 접힌 레일에서 저절로 열린 업데이트 카드는 입력창 독과 겹치지 않는다(#5661 수리 2회차 H2, planner 결정).
 *
 * 카드 자리는 Radix Popper(floating-ui)가 실제 배치로 정하므로 엔진에서 잰다. 시험대(`railCard.harness.tsx`)는 레일 바닥의 알약과
 * 대화 판 바닥의 입력창 독(`composer-dock` · `composer-card`)을 세우고 설치를 마친 업데이트를 심어 카드를 저절로 열게 한다.
 * 엔진(설치된 Chromium · WebKit) × 창(1280×800 · 720×480 · 640×400 @2x) × 카드(기다림 · 기다린 뒤 예고)마다 카드 상자와 독 상자의
 * 겹친 넓이가 0이고 카드가 창 안에 있는지 본다. 사보타주: `UpdateButton.tsx`에서 레일 카드의 `collisionPadding`·`sticky`를 끄면
 * 모든 칸이 붉다. 엔진이 없으면 경고를 남기고 건너뛴다(다른 브라우저 시험과 같은 규약) — 건너뛴 칸은 통과가 아니다.
 */

const require_ = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(HERE, "../../..");
const SRC = join(WEB_ROOT, "src");
const CORE_SRC = join(WEB_ROOT, "../../packages/momo-core/src");
const HARNESS = join(HERE, "railCard.harness.tsx");

type EngineName = "chromium" | "webkit";
type Box = { x: number; y: number; width: number; height: number };

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
  if (missing !== null) console.warn(`rail update card browser test: Playwright ${name} missing (${missing})`);
  return missing === null;
});

const WINDOWS = [
  { label: "1280", viewport: { width: 1280, height: 800 }, scale: 1 },
  { label: "720", viewport: { width: 720, height: 480 }, scale: 1 },
  { label: "640@2x", viewport: { width: 640, height: 400 }, scale: 2 },
] as const;

const MODES = ["hold", "countdown"] as const;

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
      "import.meta.url": JSON.stringify("https://example.test/rail-card-harness.js"),
    },
    logLevel: "silent",
  });
  const js = bundled.outputFiles[0]?.text;
  if (!js) throw new Error("esbuild produced no rail card harness");
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
  const sources = [
    "UpdateButton.tsx",
    "railCard.harness.tsx",
    "../../design/ui/popover.tsx",
    "../../design/ui/button.tsx",
    "../settings/shell/SettingsNav.tsx",
  ];
  const css = compiler.build([...new Set(sources.flatMap((file) => quotedClassTokens(readFileSync(join(HERE, file), "utf8"))))]);
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

async function openHarness(
  engine: EngineName,
  win: (typeof WINDOWS)[number],
  mode: (typeof MODES)[number],
  placement: "rail" | "row" | "settings" = "rail"
): Promise<{ page: Page; close: () => Promise<void> }> {
  const browser = browsers.get(engine);
  if (!browser || !assets) throw new Error(`${engine} not launched`);
  const context = await browser.newContext({ viewport: win.viewport, deviceScaleFactor: win.scale, locale: "ko-KR" });
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setContent(
    `<!doctype html><html><head><style>
html, body, #root { height: 100%; margin: 0; }
${assets.css}
</style></head><body><div id="root"></div>
<script>window.__railCardMode = ${JSON.stringify(mode)}; window.__railCardPlacement = ${JSON.stringify(placement)};</script>
<script>${assets.js}</script>
</body></html>`,
    { waitUntil: "domcontentloaded" }
  );
  return { page, close: () => context.close() };
}

/** 카드가 열려 자리를 잡을 때까지(세 프레임 연달아 같은 상자). */
async function settledCard(page: Page): Promise<Box> {
  await page.waitForFunction(
    () => {
      const card = document.querySelector('[data-testid="update-card"]');
      if (!(card instanceof HTMLElement)) return false;
      const r = card.getBoundingClientRect();
      const key = [r.x, r.y, r.width, r.height].join(",");
      const w = window as unknown as { __cardKey?: string; __cardStreak?: number };
      w.__cardStreak = r.width > 0 && w.__cardKey === key ? (w.__cardStreak ?? 0) + 1 : 0;
      w.__cardKey = key;
      return w.__cardStreak >= 3;
    },
    undefined,
    { timeout: 10_000, polling: "raf" }
  );
  return boxOf(page, '[data-testid="update-card"]');
}

async function boxOf(page: Page, selector: string): Promise<Box> {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, selector);
  if (box === null) throw new Error(`${selector} not found`);
  return box;
}

const overlapArea = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

const cells = ENGINES.flatMap((engine) => WINDOWS.flatMap((win) => MODES.map((mode) => ({ engine, win, mode }))));

describe.skipIf(ENGINES.length === 0)("접힌 레일에서 저절로 열린 업데이트 카드는 입력창 독과 겹치지 않는다 (#5661)", () => {
  it.each(cells)("$engine $win.label $mode", async (cell) => {
    const { page, close } = await openHarness(cell.engine, cell.win, cell.mode);
    try {
      const card = await settledCard(page);
      const dock = await boxOf(page, "[data-composer-shell]");
      const pill = await boxOf(page, '[data-testid="update-pill"]');
      // 잴 것이 비어 있으면 실패다(빈 상자끼리는 늘 겹침 0).
      expect(card.width).toBeGreaterThan(100);
      expect(dock.width).toBeGreaterThan(100);
      expect(dock.height).toBeGreaterThan(20);
      // 독은 카드가 닿는 가로 폭 안에 있다: 겹침 0이 「옆에 있어서」가 아니라 「위에 서서」임을 확인한다.
      expect(dock.x).toBeLessThan(card.x + card.width);
      expect(overlapArea(card, dock)).toBe(0);
      expect(card.y + card.height).toBeLessThanOrEqual(dock.y);
      expect(card.y).toBeGreaterThanOrEqual(0);
      expect(card.x).toBeGreaterThan(pill.x);
      expect(card.x + card.width).toBeLessThanOrEqual(cell.win.viewport.width);
    } finally {
      await close();
    }
  }, 30_000);
});

const relaunches = (page: Page) => page.evaluate(() => window.__railCard.relaunches());
const focusedTestId = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName ?? null);

/** 저절로 열린 카드를 Esc로 닫고 입력창에 글을 써 둔 상태(초점 입력창)에서 시작한다. */
async function typingWithCardClosed(page: Page): Promise<void> {
  await settledCard(page);
  await page.keyboard.press("Escape");
  await page.locator('[data-testid="update-card"]').waitFor({ state: "detached" });
  await page.locator('[data-testid="composer-input"]').click();
  await page.keyboard.type("오늘 배포 전에 확인할 것");
}

const focusCells = ENGINES.flatMap((engine) => (["rail", "row"] as const).map((placement) => ({ engine, placement })));

/**
 * 다시 시작을 실행하는 단추는 어떤 길로 카드가 열려도 첫 초점을 받지 않는다(#5661 수리 3회차 H1). 알약에 초점이 있을 때의 Enter·Space는
 * 카드를 열 뿐이고, 카드를 Esc · 입력창 누름 · 바깥 누름으로 닫은 뒤 이어 친 키 두 번도 다시 시작이 되지 않는다. 엔진 둘 × 펼침 · 레일.
 * 사보타주: `UpdateButton.tsx` `onOpenAutoFocus`가 알약으로 연 카드에서 기본 초점(첫 단추)을 두면 「알약 → Enter」와 「Esc」 칸이 붉다.
 */
describe.skipIf(ENGINES.length === 0)("업데이트 카드의 초점 길 넷 — 다시 시작 단추는 첫 초점을 받지 않는다 (#5661)", () => {
  it.each(focusCells)("$engine $placement: 알약 → Enter", async (cell) => {
    const { page, close } = await openHarness(cell.engine, WINDOWS[0], "hold", cell.placement);
    try {
      await typingWithCardClosed(page);
      await page.locator('[data-testid="update-pill"]').focus();
      await page.keyboard.press("Enter");
      await settledCard(page);
      expect(await focusedTestId(page)).toBe("update-card");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Space");
      await page.waitForTimeout(200);
      expect(await relaunches(page)).toBe(0);
    } finally {
      await close();
    }
  }, 30_000);

  it.each(focusCells)("$engine $placement: 알약 → 카드 → Esc → Enter 두 번 · Space 두 번", async (cell) => {
    const { page, close } = await openHarness(cell.engine, WINDOWS[0], "hold", cell.placement);
    try {
      await typingWithCardClosed(page);
      await page.locator('[data-testid="update-pill"]').click();
      await settledCard(page);
      expect(await focusedTestId(page)).not.toBe("update-card-now");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      for (const key of ["Enter", "Enter", "Space", "Space"]) await page.keyboard.press(key);
      await page.waitForTimeout(200);
      expect(await relaunches(page)).toBe(0);
      expect(await page.locator('[data-testid="composer-input"]').inputValue()).toBe("오늘 배포 전에 확인할 것");
    } finally {
      await close();
    }
  }, 30_000);

  it.each(focusCells)("$engine $placement: 알약 → 카드 → 입력창 누름 → Enter 두 번", async (cell) => {
    const { page, close } = await openHarness(cell.engine, WINDOWS[0], "hold", cell.placement);
    try {
      await typingWithCardClosed(page);
      await page.locator('[data-testid="update-pill"]').click();
      await settledCard(page);
      await page.locator('[data-testid="composer-input"]').click();
      await page.waitForTimeout(400);
      expect(await focusedTestId(page)).toBe("composer-input");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(200);
      expect(await relaunches(page)).toBe(0);
    } finally {
      await close();
    }
  }, 30_000);

  it.each(focusCells)("$engine $placement: 알약 → 카드 → 바깥(대화) 누름 → Space 두 번", async (cell) => {
    const { page, close } = await openHarness(cell.engine, WINDOWS[0], "hold", cell.placement);
    try {
      await typingWithCardClosed(page);
      await page.locator('[data-testid="update-pill"]').click();
      await settledCard(page);
      const talk = await boxOf(page, '[data-testid="conversation"]');
      await page.mouse.click(talk.x + talk.width / 2, talk.y + 40);
      await page.waitForTimeout(400);
      expect(await focusedTestId(page)).not.toBe("update-pill");
      await page.keyboard.press("Space");
      await page.keyboard.press("Space");
      await page.waitForTimeout(200);
      expect(await relaunches(page)).toBe(0);
    } finally {
      await close();
    }
  }, 30_000);
});

/**
 * 접힌 레일의 기다림 카드는 초안이 자라 입력창 독이 커지면 곧바로(다음 그리기를 기다리지 않고) 다시 위로 선다(#5661 수리 3회차 M2).
 * 사보타주: `UpdateButton.tsx`의 독 크기 관찰을 빼면 붉다(이 시험대에는 카드를 다시 그리는 시계가 없다).
 */
describe.skipIf(ENGINES.length === 0)("접힌 레일 카드는 초안이 자라도 입력창 독과 겹치지 않는다 (#5661)", () => {
  it.each(ENGINES.flatMap((engine) => WINDOWS.map((win) => ({ engine, win }))))("$engine $win.label", async (cell) => {
    const { page, close } = await openHarness(cell.engine, cell.win, "hold", "rail");
    try {
      await settledCard(page);
      await page.evaluate(() => {
        const field = document.querySelector('[data-testid="composer-input"]');
        if (field instanceof HTMLTextAreaElement) field.rows = 8;
        // 앞에서 잡은 「같은 상자 세 프레임」을 지운다: 자란 뒤의 자리를 새로 잡게.
        const w = window as unknown as { __cardKey?: string; __cardStreak?: number };
        w.__cardKey = undefined;
        w.__cardStreak = 0;
      });
      // 5초 판정 시계가 없는 시험대에서 300ms 안에 따라와야 한다(크기 관찰이 없으면 그대로 겹친다).
      await page.waitForTimeout(300);
      const card = await settledCard(page);
      const dock = await boxOf(page, "[data-composer-shell]");
      expect(dock.height).toBeGreaterThan(100);
      expect(overlapArea(card, dock)).toBe(0);
      expect(card.y).toBeGreaterThanOrEqual(0);
    } finally {
      await close();
    }
  }, 30_000);
});

/**
 * 시험대의 셈이 실제로 움직이는지(위 「다시 시작 0번」 단정이 헛돌지 않는지)와, 단추에 닿는 길이 Tab이라는 것. 틀에 초점이 선 뒤
 * Tab → 「지금 다시 시작」 → Enter면 다시 시작 1번(Chromium). WebKit 기본 설정은 Tab이 단추에 서지 않아(macOS 「키보드 탐색」 꺼짐과
 * 같음) 누름으로 셈만 확인한다.
 */
describe.skipIf(ENGINES.length === 0)("틀에서 Tab으로 단추에 닿고, 그때만 다시 시작한다 (#5661 수리 3회차)", () => {
  it.each(focusCells)("$engine $placement", async (cell) => {
    const { page, close } = await openHarness(cell.engine, WINDOWS[0], "hold", cell.placement);
    try {
      await typingWithCardClosed(page);
      await page.locator('[data-testid="update-pill"]').focus();
      await page.keyboard.press("Enter");
      await settledCard(page);
      expect(await focusedTestId(page)).toBe("update-card");
      if (cell.engine === "chromium") {
        await page.keyboard.press("Tab");
        expect(await focusedTestId(page)).toBe("update-card-now");
        await page.keyboard.press("Enter");
      } else {
        // WebKit 기본값에서는 틀에서 Tab이 `body`로 나가 카드가 닫힌다(잰 값, 수리 3회차 인계). 셈은 누름으로 확인한다.
        await page.locator('[data-testid="update-card-now"]').click();
      }
      await page.waitForTimeout(200);
      expect(await relaunches(page)).toBe(1);
    } finally {
      await close();
    }
  }, 30_000);
});

/**
 * 설정 전면의 예고 알약은 목록 스크롤 바닥에 붙어, 창이 낮아 목록이 넘쳐도 알약 · 예고 카드 · 두 단추가 창 안에 선다(#5661 수리 3회차
 * M1). 사보타주: `SettingsNav.tsx` 알약 묶음의 `sticky -bottom-2`를 빼면 720×480 · 1100×760 칸이 붉다.
 */
const SETTINGS_WINDOWS = [
  { label: "720x480", viewport: { width: 720, height: 480 }, scale: 1 },
  { label: "1100x760", viewport: { width: 1100, height: 760 }, scale: 1 },
  { label: "1280x800", viewport: { width: 1280, height: 800 }, scale: 1 },
] as const;

describe.skipIf(ENGINES.length === 0)("설정 전면의 예고는 창 높이와 상관없이 창 안에 선다 (#5661)", () => {
  it.each(ENGINES.flatMap((engine) => SETTINGS_WINDOWS.map((win) => ({ engine, win }))))("$engine $win.label", async (cell) => {
    const { page, close } = await openHarness(cell.engine, cell.win, "countdown", "settings");
    try {
      await settledCard(page);
      const inView = (b: Box) =>
        b.width > 0 && b.x >= 0 && b.y >= 0 && b.x + b.width <= cell.win.viewport.width && b.y + b.height <= cell.win.viewport.height;
      for (const selector of [
        '[data-testid="settings-restart-notice"] [data-testid="update-pill"]',
        '[data-testid="update-card"]',
        '[data-testid="update-card-defer"]',
        '[data-testid="update-card-now"]',
      ]) {
        const box = await boxOf(page, selector);
        expect(inView(box), `${selector} ${JSON.stringify(box)}`).toBe(true);
      }
    } finally {
      await close();
    }
  }, 30_000);
});
