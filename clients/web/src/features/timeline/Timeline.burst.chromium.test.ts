import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";
import { ENTER_CONVERSATION_ANIMATION_NAME, ENTER_CONVERSATION_CLASS } from "@/design/motion";
import { AT_BOTTOM_SLACK_PX } from "./navigation";

/**
 * Chromium half of Timeline burst (#2050 R5). Node environment so
 * esbuild's TextEncoder invariant holds. jsdom cannot deliver `atBottom`
 * after `scrollToIndex("LAST")`; these cases need real virtuoso geometry.
 *
 * 제품 경로 재생 단정은 로컬 게이트·design-review의 Chromium 레인에서만;
 * CI 유닛 레인은 grant 단정까지 (`it.skipIf(!chromiumAvailable)`).
 *
 * Waits settle on product state (see `measureArrivalStarts`): no grant left
 * for the delivered ids and no row still carrying `enter-conversation`.
 * `animationend` before N is not a ceiling — under load the starts land in
 * separate frames after the first 500ms entrance ended (#3082). No
 * wall-clock sleep, no rAF counting in the arrival cases.
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
  // Deterministic load lever (#3082): OORT_BURST_CPU_THROTTLE=30 slows the
  // page's main thread 30x so arrivals land in separate frames the way a
  // load≥20 merge-tree run makes them. Unset = rate 1 = no-op.
  const throttle = Number(process.env.OORT_BURST_CPU_THROTTLE ?? "1");
  if (throttle > 1) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  }
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

/**
 * 「바닥」 precondition for the same-tick cases. `timeline-virtuoso` attached
 * is not enough: under load virtuoso can still be reporting "not at bottom"
 * from its first measurement pass (the jump-latest pill is up, gap already
 * inside the slack) when the burst lands, and Timeline then correctly treats
 * the reader as scrolled up — 1 leftover grant, 1 play (#3082 probe:
 * `PRE pill=true rows=8 gap=44` → got 1). Wait until the history rows are
 * mounted, the scroller sits within the slack of its bottom and virtuoso
 * agrees (no jump-latest pill), on two consecutive frames. Frame-paced, no
 * frame budget: a timeline that never settles at bottom fails the test by
 * its own timeout.
 */
async function waitForSettledBottom(
  page: import("playwright").Page,
  historyRows: number
): Promise<void> {
  await page.evaluate(
    async ({ rows, slack }) => {
      await new Promise<void>((resolve) => {
        let streak = 0;
        const atBottom = () => {
          const scroller = document.querySelector("[data-virtuoso-scroller]");
          if (!(scroller instanceof HTMLElement)) return false;
          const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
          return (
            document.querySelectorAll("[data-testid='timeline-message']").length >= rows &&
            gap <= slack &&
            document.querySelector("[data-testid='jump-latest']") === null
          );
        };
        const onFrame = () => {
          streak = atBottom() ? streak + 1 : 0;
          if (streak >= 2) resolve();
          else requestAnimationFrame(onFrame);
        };
        requestAnimationFrame(onFrame);
      });
    },
    { rows: historyRows, slack: AT_BOTTOM_SLACK_PX }
  );
}

/**
 * Counts `motion-enter-conversation` starts for one live delivery and settles
 * on product state, not on time. Settled = no delivered id still holds a
 * play grant (every granted row mounted and consumed it, or the cap evicted
 * it) AND no row still carries `enter-conversation` (every started entrance
 * ran to animationend and dropped the class). At settle the start count is
 * final; the caller asserts it. Under load the three starts can land in
 * separate frames after the first 500ms entrance already ended (#3082), so
 * `animationend` is not a ceiling. The check runs on every start/end, DOM
 * mutation and frame — grant consumption is a ref write with no mutation,
 * so a product that never applies the class still settles (and fails) on
 * the next frame instead of hanging to the test timeout. No frame budget,
 * no wall clock.
 */
async function measureArrivalStarts(
  page: import("playwright").Page,
  ids: readonly string[],
  want: number,
  body: string,
  seqStart: number
): Promise<number> {
  return page.evaluate(
    async ({ animationName, entranceClass, nextIds, want: need, body: text, seqStart: seq }) => {
      const burst = window.__timelineBurst;
      const baseline = burst.arrivalStarts();
      const got = () => burst.arrivalStarts() - baseline;
      return await new Promise<number>((resolve, reject) => {
        let frameHandle = 0;
        let done = false;
        const settled = () =>
          burst.playCount(nextIds) === 0 &&
          document.querySelectorAll(`.${entranceClass}`).length === 0;
        const check = () => {
          if (done) return;
          if (got() > need) {
            finish();
            reject(
              new Error(
                `${animationName} animationstart ceiling: expected ${need}, got ${got()}`
              )
            );
            return;
          }
          if (settled()) {
            finish();
            resolve(got());
          }
        };
        const onAnimation = (event: AnimationEvent) => {
          if (event.animationName === animationName) check();
        };
        const onFrame = () => {
          check();
          if (!done) frameHandle = requestAnimationFrame(onFrame);
        };
        const obs = new MutationObserver(check);
        function finish() {
          done = true;
          document.removeEventListener("animationstart", onAnimation, true);
          document.removeEventListener("animationend", onAnimation, true);
          obs.disconnect();
          cancelAnimationFrame(frameHandle);
        }
        document.addEventListener("animationstart", onAnimation, true);
        document.addEventListener("animationend", onAnimation, true);
        burst.deliverLive(nextIds, seq, text);
        if (burst.playCount(nextIds) === 0) {
          finish();
          reject(new Error(`deliverLive issued no play grant for ${nextIds.length} arrivals`));
          return;
        }
        obs.observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["class"],
        });
        frameHandle = requestAnimationFrame(onFrame);
      });
    },
    {
      animationName: ENTER_CONVERSATION_ANIMATION_NAME,
      entranceClass: ENTER_CONVERSATION_CLASS,
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
        await waitForSettledBottom(handle.page, 8);
        const measured = await measureArrivalStarts(
          handle.page,
          [
            "0199eeee-0000-7000-8000-000000000411",
            "0199eeee-0000-7000-8000-000000000412",
            "0199eeee-0000-7000-8000-000000000413",
          ],
          3,
          "같은 틱 arrival",
          21
        );
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
        await waitForSettledBottom(handle.page, 8);
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
