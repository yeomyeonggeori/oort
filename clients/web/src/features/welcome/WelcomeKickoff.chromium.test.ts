import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";
import {
  ENTER_CONVERSATION_CLASS,
  WELCOME_KICKOFF_EXIT_CLASS,
  WELCOME_KICKOFF_MARK_CLASS,
} from "@/design/motion";
import { WELCOME_KICKOFF_SHAPES } from "./welcomeKickoff";

/**
 * Chromium half of UX-R2b. Node environment (not jsdom) so esbuild's
 * TextEncoder invariant holds. The product path is the harness: real Timeline
 * + useTimeline + useWelcomeKickoff. jsdom covers the same wiring with
 * dispatched animationend.
 */

const require_ = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(HERE, "../../..");
const SRC = join(WEB_ROOT, "src");
const CORE_SRC = join(WEB_ROOT, "../../packages/momo-core/src");
const HARNESS = join(HERE, "welcomeKickoff.harness.tsx");

function detectChromium(): { ok: true } | { ok: false; path: string } {
  try {
    const { chromium } = require_("playwright") as typeof import("playwright");
    const exe = chromium.executablePath();
    if (!existsSync(exe)) return { ok: false, path: exe };
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      path: err instanceof Error ? err.message : String(err),
    };
  }
}

const chromiumAvailability = detectChromium();
const chromiumAvailable = chromiumAvailability.ok;
if (!chromiumAvailable) {
  console.warn(
    `welcome kickoff Chromium harness skipped: Playwright Chromium executable missing (${chromiumAvailability.path})`
  );
}

function quotedClassTokens(source: string): string[] {
  const tokens: string[] = [];
  for (const match of source.matchAll(/["'`]([^"'`]+)["'`]/g)) {
    const chunk = match[1];
    if (chunk.includes("/") || chunk.includes("://") || chunk.includes(".tsx")) {
      continue;
    }
    for (const tok of chunk.split(/\s+/)) {
      if (!tok) continue;
      if (/^[A-Za-z0-9_:[\]/%.-]+$/.test(tok) && /[a-z]/.test(tok)) {
        tokens.push(tok);
      }
    }
  }
  return tokens;
}

declare global {
  interface Window {
    __welcomeKickoff: {
      onSubscribed: () => void;
      deliverOpener: () => void;
      stageSeenEver: () => boolean;
    };
  }
}

async function launchWelcomeHarness(opts: {
  directoryDelayMs?: number;
  backlogAgent?: boolean;
  reducedMotion?: boolean;
} = {}): Promise<{
  browser: import("playwright").Browser;
  page: import("playwright").Page;
}> {
  const { chromium } = await import("playwright");
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
      "import.meta.env": JSON.stringify({
        DEV: false,
        PROD: true,
        MODE: "test",
        SSR: false,
      }),
      "import.meta.url": JSON.stringify(
        "https://example.test/welcome-kickoff-harness.js"
      ),
    },
    logLevel: "silent",
  });
  const js = bundled.outputFiles[0]?.text;
  if (!js) throw new Error("esbuild produced no welcome kickoff harness");
  const tokensPath = join(HERE, "../../design/tokens.css");
  const compiler = await compile(readFileSync(tokensPath, "utf8"), {
    base: dirname(tokensPath),
    loadStylesheet: async (id: string, base: string) => {
      if (id === "tailwindcss" || id.endsWith("tailwindcss/index.css")) {
        const path = require_.resolve("tailwindcss/index.css");
        return {
          path,
          base: dirname(path),
          content: readFileSync(path, "utf8"),
        };
      }
      const path = id.startsWith(".") || id.startsWith("/") ? `${base}/${id}` : id;
      return { path, base: dirname(path), content: readFileSync(path, "utf8") };
    },
  });
  const candidates = [
    WELCOME_KICKOFF_EXIT_CLASS,
    WELCOME_KICKOFF_MARK_CLASS,
    ENTER_CONVERSATION_CLASS,
    "welcome-kickoff-body",
    "h-full",
    "relative",
    ...quotedClassTokens(readFileSync(join(HERE, "WelcomeKickoffStage.tsx"), "utf8")),
    ...quotedClassTokens(readFileSync(join(HERE, "../timeline/Timeline.tsx"), "utf8")),
    ...quotedClassTokens(
      readFileSync(join(HERE, "../timeline/ChannelIntroBlock.tsx"), "utf8")
    ),
    ...quotedClassTokens(readFileSync(join(HERE, "../timeline/MessageRow.tsx"), "utf8")),
  ];
  const css = compiler.build([...new Set(candidates)]);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => {
    pageErrors.push(err instanceof Error ? err.message : String(err));
  });
  await page.emulateMedia({
    reducedMotion: opts.reducedMotion ? "reduce" : "no-preference",
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  const boot = JSON.stringify({
    directoryDelayMs: opts.directoryDelayMs ?? 0,
    backlogAgent: Boolean(opts.backlogAgent),
    reducedMotion: Boolean(opts.reducedMotion),
  });
  await page.setContent(
    `<!doctype html><html><head><style>
html, body, #root { height: 100%; margin: 0; }
${css}
</style></head><body>
<div id="root"></div>
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
  const local = memory();
  const session = memory();
  Object.defineProperty(window, "localStorage", { value: local });
  Object.defineProperty(window, "sessionStorage", { value: session });
  window.matchMedia = (query) => ({
    matches: Boolean(window.__welcomeKickoffOpts?.reducedMotion) &&
      String(query).includes("prefers-reduced-motion: reduce"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false; },
  });
  window.__welcomeKickoffOpts = ${boot};
})();
</script>
<script>${js}</script>
</body></html>`,
    { waitUntil: "domcontentloaded" }
  );
  try {
    await page.waitForFunction(() => Boolean(window.__welcomeKickoff), {
      timeout: 10_000,
    });
  } catch (err) {
    await browser.close();
    const extra = pageErrors.length > 0 ? ` pageerror=${pageErrors.join("; ")}` : "";
    throw new Error(
      `welcome harness did not boot.${extra} ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (pageErrors.length > 0) {
    await browser.close();
    throw new Error(`welcome harness pageerror: ${pageErrors.join("; ")}`);
  }
  return { browser, page };
}

describe("welcome kickoff Chromium harness", () => {
  it.skipIf(!chromiumAvailable)(
    "agent backlog + roster delayed 2000ms → no stage at any point",
    async () => {
      const handle = await launchWelcomeHarness({
        directoryDelayMs: 2000,
        backlogAgent: true,
      });
      try {
        await handle.page.evaluate(() => window.__welcomeKickoff.onSubscribed());
        await handle.page.waitForTimeout(2500);
        expect(
          await handle.page.evaluate(() => window.__welcomeKickoff.stageSeenEver())
        ).toBe(false);
        expect(
          await handle.page.locator("[data-testid='welcome-kickoff-stage']").count()
        ).toBe(0);
      } finally {
        await handle.browser.close();
      }
    },
    30_000
  );

  it.skipIf(!chromiumAvailable)(
    "empty channel + roster delayed 2000ms → stage only after roster settles",
    async () => {
      const handle = await launchWelcomeHarness({ directoryDelayMs: 2000 });
      try {
        await handle.page.evaluate(() => window.__welcomeKickoff.onSubscribed());
        const pendingLog = await handle.page.evaluate(async () => {
          const rows: { t: number; write: boolean; stage: boolean }[] = [];
          const start = performance.now();
          while (performance.now() - start < 1800) {
            rows.push({
              t: Math.round(performance.now() - start),
              write: Boolean(
                document.querySelector("[data-testid='timeline-empty-primary']")
              ),
              stage: Boolean(
                document.querySelector("[data-testid='welcome-kickoff-stage']")
              ),
            });
            await new Promise((resolve) => window.setTimeout(resolve, 50));
          }
          return rows;
        });
        expect(pendingLog.every((row) => row.write === false)).toBe(true);
        expect(pendingLog.every((row) => row.stage === false)).toBe(true);
        expect(
          await handle.page.locator("[data-testid='welcome-kickoff-stage']").count()
        ).toBe(0);
        await handle.page
          .locator("[data-testid='welcome-kickoff-stage']")
          .waitFor({ state: "attached", timeout: 4000 });
        expect(
          await handle.page.evaluate(() => window.__welcomeKickoff.stageSeenEver())
        ).toBe(true);
      } finally {
        await handle.browser.close();
      }
    },
    30_000
  );

  it.skipIf(!chromiumAvailable)(
    "product path: opener arrival starts at or after stage exit end",
    async () => {
      const handle = await launchWelcomeHarness();
      try {
        await handle.page.evaluate(() => window.__welcomeKickoff.onSubscribed());
        await handle.page
          .locator("[data-testid='welcome-kickoff-stage']")
          .waitFor({ state: "attached", timeout: 4000 });
        const measured = await handle.page.evaluate(async () => {
          return await new Promise<{
            exitEndedMs: number;
            arrivalStartMs: number;
            deltaMs: number;
            arrivalDuringExit: boolean;
          }>((resolve, reject) => {
            const timeout = window.setTimeout(
              () => reject(new Error("product exit→arrival did not complete")),
              4000
            );
            let exitEndedMs = 0;
            let exitRunning = false;
            document.addEventListener(
              "animationstart",
              (event) => {
                if (event.animationName === "motion-fade-out") exitRunning = true;
              },
              true
            );
            document.addEventListener(
              "animationend",
              (event) => {
                if (event.animationName !== "motion-fade-out") return;
                exitEndedMs = performance.now();
                exitRunning = false;
              },
              true
            );
            document.addEventListener(
              "animationstart",
              (event) => {
                if (event.animationName !== "motion-enter-conversation") return;
                const arrivalStartMs = performance.now();
                window.clearTimeout(timeout);
                resolve({
                  exitEndedMs,
                  arrivalStartMs,
                  deltaMs: arrivalStartMs - exitEndedMs,
                  arrivalDuringExit: exitRunning,
                });
              },
              true
            );
            window.__welcomeKickoff.deliverOpener();
          });
        });
        console.info(
          `welcome kickoff product exit→arrival exitEndedMs=${measured.exitEndedMs.toFixed(1)} arrivalStartMs=${measured.arrivalStartMs.toFixed(1)} deltaMs=${measured.deltaMs.toFixed(1)} arrivalDuringExit=${measured.arrivalDuringExit}`
        );
        expect(measured.exitEndedMs).toBeGreaterThan(0);
        expect(measured.arrivalDuringExit).toBe(false);
        expect(measured.deltaMs).toBeGreaterThanOrEqual(0);
      } finally {
        await handle.browser.close();
      }
    },
    40_000
  );

  it.skipIf(!chromiumAvailable)(
    "product path N=5: exit→arrival deltaMs min/median/max",
    async () => {
      const deltas: number[] = [];
      for (let sample = 0; sample < 5; sample += 1) {
        const handle = await launchWelcomeHarness();
        try {
          await handle.page.evaluate(() => window.__welcomeKickoff.onSubscribed());
          await handle.page
            .locator("[data-testid='welcome-kickoff-stage']")
            .waitFor({ state: "attached", timeout: 4000 });
          const measured = await handle.page.evaluate(async () => {
            return await new Promise<{
              exitEndedMs: number;
              arrivalStartMs: number;
              deltaMs: number;
              arrivalDuringExit: boolean;
            }>((resolve, reject) => {
              const timeout = window.setTimeout(
                () => reject(new Error("product exit→arrival did not complete")),
                4000
              );
              let exitEndedMs = 0;
              let exitRunning = false;
              document.addEventListener(
                "animationstart",
                (event) => {
                  if (event.animationName === "motion-fade-out") exitRunning = true;
                },
                true
              );
              document.addEventListener(
                "animationend",
                (event) => {
                  if (event.animationName !== "motion-fade-out") return;
                  exitEndedMs = performance.now();
                  exitRunning = false;
                },
                true
              );
              document.addEventListener(
                "animationstart",
                (event) => {
                  if (event.animationName !== "motion-enter-conversation") return;
                  const arrivalStartMs = performance.now();
                  window.clearTimeout(timeout);
                  resolve({
                    exitEndedMs,
                    arrivalStartMs,
                    deltaMs: arrivalStartMs - exitEndedMs,
                    arrivalDuringExit: exitRunning,
                  });
                },
                true
              );
              window.__welcomeKickoff.deliverOpener();
            });
          });
          expect(measured.exitEndedMs).toBeGreaterThan(0);
          expect(measured.arrivalDuringExit).toBe(false);
          deltas.push(measured.deltaMs);
        } finally {
          await handle.browser.close();
        }
      }
      const sorted = [...deltas].sort((a, b) => a - b);
      const min = sorted[0] ?? 0;
      const max = sorted[sorted.length - 1] ?? 0;
      const median = sorted[2] ?? 0;
      console.info(
        `welcome kickoff product exit→arrival N=5 deltaMs min=${min.toFixed(1)} median=${median.toFixed(1)} max=${max.toFixed(1)} samples=${deltas.map((n) => n.toFixed(1)).join(",")}`
      );
      expect(deltas).toHaveLength(5);
    },
    120_000
  );

  it.skipIf(!chromiumAvailable)(
    "welcome marks render CLOUD_BODIES size and reduced pose equals end rotate",
    async () => {
      const animated = await launchWelcomeHarness();
      try {
        await animated.page.evaluate(() => window.__welcomeKickoff.onSubscribed());
        await animated.page
          .locator("[data-testid='welcome-kickoff-stage']")
          .waitFor({ state: "attached", timeout: 4000 });
        const boxes = await animated.page.evaluate(() =>
          [...document.querySelectorAll(".welcome-kickoff-body")].map((el) => {
            const style = getComputedStyle(el);
            return {
              body: el.getAttribute("data-onboarding-body"),
              width: Number.parseFloat(style.width),
              height: Number.parseFloat(style.height),
            };
          })
        );
        expect(boxes.length).toBe(WELCOME_KICKOFF_SHAPES.length);
        for (const [index, shape] of WELCOME_KICKOFF_SHAPES.entries()) {
          expect(boxes[index]?.body).toBe(String(shape.index));
          expect(boxes[index]?.width).toBe(shape.size);
          expect(boxes[index]?.height).toBe(shape.size);
        }
      } finally {
        await animated.browser.close();
      }

      const reduced = await launchWelcomeHarness({ reducedMotion: true });
      try {
        await reduced.page.evaluate(() => window.__welcomeKickoff.onSubscribed());
        await reduced.page
          .locator("[data-testid='welcome-kickoff-stage']")
          .waitFor({ state: "attached", timeout: 4000 });
        const poses = await reduced.page.evaluate(() =>
          [...document.querySelectorAll(".welcome-kickoff-body")].map((el) => ({
            body: el.getAttribute("data-onboarding-body"),
            transform: getComputedStyle(el).transform,
            stagger: el.getAttribute("data-stagger-index"),
          }))
        );
        expect(poses.every((row) => row.stagger === null)).toBe(true);
        for (const [index, shape] of WELCOME_KICKOFF_SHAPES.entries()) {
          const transform = poses[index]?.transform ?? "none";
          expect(transform, `body ${shape.index} reduced transform`).not.toBe("none");
          const nums = transform.match(/-?\d+\.?\d*(?:e[+-]?\d+)?/gi);
          expect(nums && nums.length >= 4).toBe(true);
          const a = Number(nums?.[0]);
          const b = Number(nums?.[1]);
          const deg = (Math.atan2(b, a) * 180) / Math.PI;
          expect(Math.abs(deg - shape.rotate)).toBeLessThan(0.6);
        }
      } finally {
        await reduced.browser.close();
      }
    },
    60_000
  );
});
