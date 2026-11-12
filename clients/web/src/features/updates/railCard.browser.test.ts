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
  const sources = ["UpdateButton.tsx", "railCard.harness.tsx", "../../design/ui/popover.tsx", "../../design/ui/button.tsx"];
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
  mode: (typeof MODES)[number]
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
<script>window.__railCardMode = ${JSON.stringify(mode)};</script>
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
