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
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1280, height: 800 });
  const boot = JSON.stringify({
    directoryDelayMs: opts.directoryDelayMs ?? 0,
    backlogAgent: Boolean(opts.backlogAgent),
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
    matches: false,
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
        await handle.page.waitForTimeout(400);
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
});
