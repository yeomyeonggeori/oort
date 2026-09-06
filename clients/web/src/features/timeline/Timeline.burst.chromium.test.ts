import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";
import { ENTER_CONVERSATION_ANIMATION_NAME, ENTER_CONVERSATION_CLASS } from "@/design/motion";

/**
 * Chromium half of Timeline burst (#2050 R5). Node environment so
 * esbuild's TextEncoder invariant holds. jsdom cannot deliver `atBottom`
 * after `scrollToIndex("LAST")`; these cases need real virtuoso geometry.
 *
 * 제품 경로 재생 단정은 로컬 게이트·design-review의 Chromium 레인에서만;
 * CI 유닛 레인은 grant 단정까지 (`it.skipIf(!chromiumAvailable)`).
 *
 * Waits are event-driven: `animationstart` for `motion-enter-conversation`
 * resolves a promise at N, and `animationend` before N is a loud ceiling.
 * No wall-clock sleep, no rAF counting.
 */

const require_ = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(HERE, "../../..");
const SRC = join(WEB_ROOT, "src");
const CORE_SRC = join(WEB_ROOT, "../../packages/momo-core/src");
const HARNESS = join(HERE, "timelineBurst.harness.tsx");

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
    `Timeline burst Chromium harness skipped: Playwright Chromium executable missing (${chromiumAvailability.path})`
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

function arrivalIds(count: number, prefix = "0199dddd-0000-7000-8000-0000000007"): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(2, "0")}`);
}

declare global {
  interface Window {
    __timelineBurstOpts?: { history?: number };
    __timelineBurst: {
      onSubscribed: () => void;
      deliverLive: (ids: readonly string[], seqStart: number, body: string) => void;
      arrivalStarts: () => number;
      playCount: (ids: readonly string[]) => number;
      playIds: (ids: readonly string[]) => string[];
    };
  }
}

async function launchBurstHarness(opts: { history?: number } = {}): Promise<{
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
      "import.meta.url": JSON.stringify("https://example.test/timeline-burst-harness.js"),
    },
    logLevel: "silent",
  });
  const js = bundled.outputFiles[0]?.text;
  if (!js) throw new Error("esbuild produced no timeline burst harness");
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
    ENTER_CONVERSATION_CLASS,
    "h-full",
    "relative",
    ...quotedClassTokens(readFileSync(join(HERE, "Timeline.tsx"), "utf8")),
    ...quotedClassTokens(readFileSync(join(HERE, "MessageRow.tsx"), "utf8")),
    ...quotedClassTokens(readFileSync(join(HERE, "UnreadPill.tsx"), "utf8")),
    ...quotedClassTokens(readFileSync(join(HERE, "ChannelIntroBlock.tsx"), "utf8")),
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
  const boot = JSON.stringify({ history: opts.history ?? 8 });
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
  Object.defineProperty(window, "localStorage", { value: memory() });
  Object.defineProperty(window, "sessionStorage", { value: memory() });
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false; },
  });
  window.__timelineBurstOpts = ${boot};
})();
</script>
<script>${js}</script>
</body></html>`,
    { waitUntil: "domcontentloaded" }
  );
  try {
    await page.waitForFunction(() => Boolean(window.__timelineBurst), {
      timeout: 10_000,
    });
  } catch (err) {
    await browser.close();
    const extra = pageErrors.length > 0 ? ` pageerror=${pageErrors.join("; ")}` : "";
    throw new Error(
      `burst harness did not boot.${extra} ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (pageErrors.length > 0) {
    await browser.close();
    throw new Error(`burst harness pageerror: ${pageErrors.join("; ")}`);
  }
  return { browser, page };
}

async function measureArrivalStarts(
  page: import("playwright").Page,
  ids: readonly string[],
  want: number,
  body: string,
  seqStart: number
): Promise<number> {
  return page.evaluate(
    async ({ animationName, nextIds, want: need, body: text, seqStart: seq }) => {
      const baseline = window.__timelineBurst.arrivalStarts();
      const current = () => window.__timelineBurst.arrivalStarts();
      return await new Promise<number>((resolve, reject) => {
        const onStart = (event: AnimationEvent) => {
          if (event.animationName !== animationName) return;
          if (current() >= baseline + need) {
            cleanup();
            resolve(current() - baseline);
          }
        };
        const onEnd = (event: AnimationEvent) => {
          if (event.animationName !== animationName) return;
          if (current() < baseline + need) {
            cleanup();
            reject(
              new Error(
                `motion-enter-conversation animationstart ceiling: expected ${need}, got ${current() - baseline} before animationend`
              )
            );
          }
        };
        function cleanup() {
          document.removeEventListener("animationstart", onStart, true);
          document.removeEventListener("animationend", onEnd, true);
        }
        document.addEventListener("animationstart", onStart, true);
        document.addEventListener("animationend", onEnd, true);
        window.__timelineBurst.deliverLive(nextIds, seq, text);
        if (current() >= baseline + need) {
          cleanup();
          resolve(current() - baseline);
        }
      });
    },
    {
      animationName: ENTER_CONVERSATION_ANIMATION_NAME,
      nextIds: ids,
      want,
      body,
      seqStart,
    }
  );
}

describe("virtualized Timeline burst (Chromium)", () => {
  it.skipIf(!chromiumAvailable)(
    "브라우저가 motion-enter-conversation 을 3회 시작한다 (virtuoso 경로의 스냅샷; jsdom 은 grant 만 센다)",
    async () => {
      const handle = await launchBurstHarness({ history: 8 });
      try {
        await handle.page.evaluate(() => window.__timelineBurst.onSubscribed());
        await handle.page.locator("[data-testid='timeline-virtuoso']").waitFor({
          state: "attached",
          timeout: 4000,
        });
        const measured = await handle.page.evaluate(async (animationName) => {
          const baseline = window.__timelineBurst.arrivalStarts();
          const want = 3;
          const current = () => window.__timelineBurst.arrivalStarts();
          return await new Promise<number>((resolve, reject) => {
            const onStart = (event: AnimationEvent) => {
              if (event.animationName !== animationName) return;
              if (current() >= baseline + want) {
                cleanup();
                resolve(current() - baseline);
              }
            };
            const onEnd = (event: AnimationEvent) => {
              if (event.animationName !== animationName) return;
              if (current() < baseline + want) {
                cleanup();
                reject(
                  new Error(
                    `motion-enter-conversation animationstart ceiling: expected ${want}, got ${current() - baseline} before animationend`
                  )
                );
              }
            };
            function cleanup() {
              document.removeEventListener("animationstart", onStart, true);
              document.removeEventListener("animationend", onEnd, true);
            }
            document.addEventListener("animationstart", onStart, true);
            document.addEventListener("animationend", onEnd, true);
            window.__timelineBurst.deliverLive(
              [
                "0199eeee-0000-7000-8000-000000000411",
                "0199eeee-0000-7000-8000-000000000412",
                "0199eeee-0000-7000-8000-000000000413",
              ],
              21,
              "같은 틱 arrival"
            );
            if (current() >= baseline + want) {
              cleanup();
              resolve(current() - baseline);
            }
          });
        }, ENTER_CONVERSATION_ANIMATION_NAME);
        expect(measured).toBe(3);
        // Settled-row computed style is real here (jsdom's injected sheet
        // never parses; animationName is always ""). History rows must not
        // carry motion-enter-conversation.
        const settledStyles = await handle.page.evaluate(() => {
          const rows = [
            ...document.querySelectorAll('[data-testid="timeline-message"]'),
          ];
          return rows
            .filter((node) => !node.classList.contains("enter-conversation"))
            .map((node) => getComputedStyle(node).animationName);
        });
        expect(settledStyles.length).toBeGreaterThan(0);
        for (const name of settledStyles) {
          expect(name.includes(ENTER_CONVERSATION_ANIMATION_NAME)).toBe(false);
          expect(name === "none" || name === "none, none").toBe(true);
        }
      } finally {
        await handle.browser.close();
      }
    },
    40_000
  );

  it.skipIf(!chromiumAvailable).each([10, 20, 30, 50])(
    "바닥 같은 틱 %i건은 motion-enter-conversation 을 3회 시작한다",
    async (n) => {
      const handle = await launchBurstHarness({ history: 8 });
      try {
        await handle.page.evaluate(() => window.__timelineBurst.onSubscribed());
        await handle.page.locator("[data-testid='timeline-virtuoso']").waitFor({
          state: "attached",
          timeout: 4000,
        });
        const ids = arrivalIds(n);
        const measured = await measureArrivalStarts(
          handle.page,
          ids,
          3,
          `바닥 같은 틱 ${n} arrival`,
          40
        );
        expect(measured).toBe(3);
      } finally {
        await handle.browser.close();
      }
    },
    40_000
  );

  it.skipIf(!chromiumAvailable)(
    "스크롤업 백로그 50건은 재생 0, 바닥 점프는 정확히 1",
    async () => {
      const handle = await launchBurstHarness({ history: 40 });
      try {
        await handle.page.evaluate(() => window.__timelineBurst.onSubscribed());
        await handle.page.locator("[data-testid='timeline-virtuoso']").waitFor({
          state: "attached",
          timeout: 4000,
        });
        await handle.page.evaluate(() => {
          const scroller =
            document.querySelector("[data-virtuoso-scroller]") ??
            document.querySelector("[data-testid='timeline-virtuoso']");
          if (!(scroller instanceof HTMLElement)) {
            throw new Error("missing timeline scroller");
          }
          scroller.scrollTop = 0;
          scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        await handle.page.locator("[data-testid='jump-latest']").waitFor({
          state: "visible",
          timeout: 4000,
        });
        const ids = arrivalIds(50);
        const lastId = ids[ids.length - 1]!;
        const before = await handle.page.evaluate(() =>
          window.__timelineBurst.arrivalStarts()
        );
        const jumped = await handle.page.evaluate(
          async ({ animationName, lastId: targetId, nextIds, baseline }) => {
            window.__timelineBurst.deliverLive(
              nextIds,
              200,
              "스크롤업 백로그 arrival"
            );
            const want = 1;
            const current = () => window.__timelineBurst.arrivalStarts();
            return await new Promise<number>((resolve, reject) => {
              let clicked = false;
              let grantedAtClick: string[] = [];
              let framesWaiting = 0;
              let framesAfterClick = 0;
              let frameHandle = 0;
              const FRAME_CEILING = 60;
              const leftoversNow = () => window.__timelineBurst.playCount(nextIds);
              const onStart = (event: AnimationEvent) => {
                if (event.animationName !== animationName) return;
                const got = current() - baseline;
                if (got > want) {
                  cleanup();
                  reject(
                    new Error(
                      `motion-enter-conversation animationstart ceiling: expected ${want}, got ${got}`
                    )
                  );
                }
              };
              const onEnd = (event: AnimationEvent) => {
                if (event.animationName !== animationName) return;
                const got = current() - baseline;
                if (got === want) {
                  cleanup();
                  resolve(got);
                } else if (got < want) {
                  cleanup();
                  reject(
                    new Error(
                      `motion-enter-conversation animationstart ceiling: expected ${want}, got ${got} before animationend`
                    )
                  );
                }
              };
              const tryClick = () => {
                if (clicked) return;
                if (leftoversNow() !== 1) return;
                const button = document.querySelector("[data-testid='jump-latest']");
                if (!(button instanceof HTMLElement)) return;
                clicked = true;
                framesAfterClick = 0;
                grantedAtClick = window.__timelineBurst.playIds(nextIds);
                button.click();
              };
              const onFrame = () => {
                if (!clicked) {
                  const leftovers = leftoversNow();
                  tryClick();
                  if (clicked) {
                    frameHandle = requestAnimationFrame(onFrame);
                    return;
                  }
                  framesWaiting += 1;
                  if (framesWaiting >= FRAME_CEILING) {
                    cleanup();
                    reject(
                      leftovers === 0
                        ? new Error(
                            `leftover grant vanished before jump (starts=${current() - baseline})`
                          )
                        : new Error(
                            `leftover grants at jump gate: expected 1, got ${leftovers}`
                          )
                    );
                    return;
                  }
                  frameHandle = requestAnimationFrame(onFrame);
                  return;
                }
                framesAfterClick += 1;
                const got = current() - baseline;
                if (got >= want) return;
                if (framesAfterClick >= FRAME_CEILING) {
                  cleanup();
                  reject(
                    new Error(
                      `jump-latest click produced ${got} motion-enter-conversation starts within ${FRAME_CEILING} frames (expected ${want}; dead control?)`
                    )
                  );
                  return;
                }
                frameHandle = requestAnimationFrame(onFrame);
              };
              const obs = new MutationObserver(() => {
                tryClick();
                if (!clicked && leftoversNow() === 0) {
                  cleanup();
                  reject(
                    new Error(
                      `leftover grant vanished before jump (starts=${current() - baseline})`
                    )
                  );
                  return;
                }
                const last = document.querySelector(
                  `[data-testid="timeline-message"][data-message-id="${targetId}"]`
                );
                const pill = document.querySelector("[data-testid='jump-latest']");
                if (
                  clicked &&
                  last instanceof HTMLElement &&
                  last.classList.contains("enter-conversation") &&
                  current() - baseline >= want
                ) {
                  cleanup();
                  resolve(current() - baseline);
                }
                if (
                  clicked &&
                  last instanceof HTMLElement &&
                  !last.classList.contains("enter-conversation") &&
                  !pill &&
                  current() === baseline
                ) {
                  cleanup();
                  reject(
                    new Error(
                      `jump landed on ${targetId} without enter-conversation (starts=0 class=${last.className} grantedAtClick=${grantedAtClick.join(",")} grantedNow=${window.__timelineBurst.playIds(nextIds).join(",")})`
                    )
                  );
                }
              });
              function cleanup() {
                document.removeEventListener("animationstart", onStart, true);
                document.removeEventListener("animationend", onEnd, true);
                obs.disconnect();
                cancelAnimationFrame(frameHandle);
              }
              document.addEventListener("animationstart", onStart, true);
              document.addEventListener("animationend", onEnd, true);
              obs.observe(document.documentElement, {
                subtree: true,
                childList: true,
                attributes: true,
              });
              frameHandle = requestAnimationFrame(onFrame);
              tryClick();
            });
          },
          {
            animationName: ENTER_CONVERSATION_ANIMATION_NAME,
            lastId,
            nextIds: ids,
            baseline: before,
          }
        );
        expect(jumped).toBe(1);
      } finally {
        await handle.browser.close();
      }
    },
    40_000
  );
});
