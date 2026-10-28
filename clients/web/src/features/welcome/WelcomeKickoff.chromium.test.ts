import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ENTER_CONVERSATION_ANIMATION_NAME,
  ENTER_CONVERSATION_CLASS,
  WELCOME_KICKOFF_EXIT_ANIMATION_NAME,
  WELCOME_KICKOFF_EXIT_CLASS,
} from "@/design/motion";
import { WELCOME_BAND_JOY_HOLD_MS } from "./welcomeKickoff";

/**
 * Chromium half of UX-R2b / #2817. Node environment (not jsdom) so esbuild's
 * TextEncoder invariant holds. The product path is the harness: real Timeline
 * + useTimeline + useWelcomeKickoff, the kickoff band, and the phone card in
 * the same slot. jsdom covers the same wiring with dispatched animationend.
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
      releaseDirectory: () => void;
      directorySettled: () => boolean;
    };
  }
}

type HarnessBuild = { js: string; css: string };

let harnessBuild: Promise<HarnessBuild> | null = null;

/**
 * 하네스 번들(esbuild)과 CSS(tailwind 컴파일)는 옵션과 무관하고 비싸다. 예전에는 `launchWelcomeHarness` 가 시험마다(이 파일에서
 * 아홉 번) 다시 만들었고, 그 CPU 가 시험 하나의 제한 시간(30 s)을 먹었다 — 부하 60~70 에서 첫 시험이 제한 시간에 걸렸다(#4708).
 * 파일에서 한 번만 만들고(`beforeAll`), 시험은 브라우저를 띄우고 옵션을 건네는 일만 한다.
 */
function buildHarness(): Promise<HarnessBuild> {
  harnessBuild ??= (async () => {
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
      loader: { ".png": "dataurl" },
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
      ENTER_CONVERSATION_CLASS,
      "h-full",
      "relative",
      ...quotedClassTokens(readFileSync(join(HERE, "WelcomeKickoffStage.tsx"), "utf8")),
      ...quotedClassTokens(readFileSync(join(HERE, "PhoneLinkChannelCard.tsx"), "utf8")),
      ...quotedClassTokens(readFileSync(HARNESS, "utf8")),
      ...quotedClassTokens(readFileSync(join(HERE, "../timeline/Timeline.tsx"), "utf8")),
      ...quotedClassTokens(
        readFileSync(join(HERE, "../timeline/ChannelIntroBlock.tsx"), "utf8")
      ),
      ...quotedClassTokens(readFileSync(join(HERE, "../timeline/MessageRow.tsx"), "utf8")),
    ];
    const css = compiler.build([...new Set(candidates)]);
    return { js, css };
  })();
  return harnessBuild;
}

async function launchWelcomeHarness(opts: {
  /** 참이면 명부가 `window.__welcomeKickoff.releaseDirectory()` 까지 「불러오는 중」이다(실시간 타이머가 아니다). */
  holdDirectory?: boolean;
  backlogAgent?: boolean;
  reducedMotion?: boolean;
} = {}): Promise<{
  browser: import("playwright").Browser;
  page: import("playwright").Page;
}> {
  const { chromium } = await import("playwright");
  const { js, css } = await buildHarness();
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
    holdDirectory: Boolean(opts.holdDirectory),
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

/**
 * 화면을 프레임마다 지켜본다: 최소 `minMs` 가 흐르고 최소 `minFrames` 프레임이 지날 때까지. 「그동안 띠·쓰기 안내가 한 번도 안 보였다」를
 * 재는 **부정 단정**의 창이다. 부정 단정은 창이 길수록 강하고, 창 안에 시험이 통제하지 않는 사건(타이머)이 끼어 있을 때만 거짓 빨강이
 * 난다 — 명부 문을 시험이 쥐고 있으면 그런 사건이 없어서 창을 길게 잡아도 부하에 흔들리지 않는다. 시간과 프레임을 둘 다 요구하는 것은
 * 느린 머신에서 프레임이 적게 그려져도, 빠른 머신에서 프레임이 많아도 창이 줄어들지 않게 하려는 것이다.
 */
async function watchWindow(
  page: import("playwright").Page,
  minMs: number,
  minFrames: number
) {
  return await page.evaluate(
    async ({ minMs: ms, minFrames: frames }) => {
      const rows: { write: boolean; stage: boolean }[] = [];
      const start = performance.now();
      while (performance.now() - start < ms || rows.length < frames) {
        rows.push({
          write: Boolean(document.querySelector("[data-testid='timeline-empty-primary']")),
          stage: Boolean(document.querySelector("[data-testid='welcome-kickoff-stage']")),
        });
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      return rows;
    },
    { minMs, minFrames }
  );
}

/** 푼 명부가 화면에 커밋될 때까지 기다린다(조건 기다림 — 시간이 아니다). */
async function waitForDirectorySettled(page: import("playwright").Page) {
  await page.waitForFunction(() => window.__welcomeKickoff.directorySettled(), undefined, {
    timeout: 20_000,
  });
}

describe("welcome kickoff Chromium harness", () => {
  // 번들·CSS 는 한 번만 만든다. 이 단계의 시간은 시험 하나의 제한 시간에서 빠진다.
  beforeAll(async () => {
    if (chromiumAvailable) await buildHarness();
  }, 120_000);

  it.skipIf(!chromiumAvailable)(
    "agent backlog + roster held → no stage at any point",
    async () => {
      const handle = await launchWelcomeHarness({
        holdDirectory: true,
        backlogAgent: true,
      });
      try {
        await handle.page.evaluate(() => window.__welcomeKickoff.onSubscribed());
        // 명부가 풀리기 전: 문을 시험이 쥐고 있어 어느 타이머와도 경주하지 않는다. 예전 창(1800 ms)을 그대로 지킨다.
        const pending = await watchWindow(handle.page, 1800, 30);
        expect(pending.every((row) => row.stage === false)).toBe(true);
        // 명부가 풀린 뒤에도 이미 에이전트의 말이 있으니 띠는 끝내 서지 않는다.
        await handle.page.evaluate(() => window.__welcomeKickoff.releaseDirectory());
        await waitForDirectorySettled(handle.page);
        const settled = await watchWindow(handle.page, 500, 30);
        expect(settled.every((row) => row.stage === false)).toBe(true);
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
    60_000
  );

  it.skipIf(!chromiumAvailable)(
    "empty channel + roster held → stage only after roster settles",
    async () => {
      const handle = await launchWelcomeHarness({ holdDirectory: true });
      try {
        await handle.page.evaluate(() => window.__welcomeKickoff.onSubscribed());
        // 명부가 풀리기 전에는 쓰기 안내도 띠도 없다. 예전 창(1800 ms)을 그대로 지킨다.
        const pending = await watchWindow(handle.page, 1800, 30);
        expect(pending.every((row) => row.write === false)).toBe(true);
        expect(pending.every((row) => row.stage === false)).toBe(true);
        expect(
          await handle.page.locator("[data-testid='welcome-kickoff-stage']").count()
        ).toBe(0);
        expect(
          await handle.page.evaluate(() => window.__welcomeKickoff.stageSeenEver())
        ).toBe(false);
        // 명부를 풀면 띠가 선다 — 시각이 아니라 조건을 기다린다.
        await handle.page.evaluate(() => window.__welcomeKickoff.releaseDirectory());
        await handle.page
          .locator("[data-testid='welcome-kickoff-stage']")
          .waitFor({ state: "attached", timeout: 20_000 });
        expect(
          await handle.page.evaluate(() => window.__welcomeKickoff.stageSeenEver())
        ).toBe(true);
      } finally {
        await handle.browser.close();
      }
    },
    60_000
  );

  it.skipIf(!chromiumAvailable)(
    "product path: opener arrival starts at once beside the joy band; the band collapses after; the phone card only after that",
    async () => {
      const handle = await launchWelcomeHarness();
      try {
        const measured = await measureOpenerPath(handle.page);
        console.info(
          `welcome band product path ${JSON.stringify(measured)}`
        );
        // (a) the row does not wait for the band (it is outside the list): a few frames, not the band's 1200 ms hold
        expect(measured.arrivalStartMs).toBeGreaterThan(0);
        expect(measured.arrivalFrame - measured.deliverFrame).toBeLessThanOrEqual(ARRIVAL_FRAME_BUDGET);
        // (b) the band shows joy around the same frame
        expect(measured.joyMs).toBeGreaterThan(0);
        expect(Math.abs(measured.joyFrame - measured.arrivalFrame)).toBeLessThanOrEqual(
          JOY_BESIDE_ARRIVAL_FRAME_BUDGET
        );
        // (c) the collapse ends after the arrival started, and after the joy hold
        expect(measured.collapseEndMs).toBeGreaterThan(measured.arrivalStartMs);
        expect(measured.collapseEndMs - measured.joyMs).toBeGreaterThanOrEqual(
          WELCOME_BAND_JOY_HOLD_MS
        );
        // (d) one slot: the phone card never shares the DOM with the band
        expect(measured.overlapSeen).toBe(false);
        expect(measured.phoneBeforeOpener).toBe(false);
        expect(measured.phoneMs).toBeGreaterThanOrEqual(measured.collapseEndMs);
      } finally {
        await handle.browser.close();
      }
    },
    40_000
  );

  it.skipIf(!chromiumAvailable)(
    "product path N=5: deliver→arrival and deliver→collapse-end deltas",
    async () => {
      const arrivals: number[] = [];
      const arrivalFrames: number[] = [];
      const collapses: number[] = [];
      for (let sample = 0; sample < 5; sample += 1) {
        const handle = await launchWelcomeHarness();
        try {
          const measured = await measureOpenerPath(handle.page);
          expect(measured.overlapSeen).toBe(false);
          expect(measured.collapseEndMs).toBeGreaterThan(measured.arrivalStartMs);
          arrivals.push(measured.arrivalStartMs - measured.deliverMs);
          arrivalFrames.push(measured.arrivalFrame - measured.deliverFrame);
          collapses.push(measured.collapseEndMs - measured.deliverMs);
        } finally {
          await handle.browser.close();
        }
      }
      const fmt = (xs: number[]) => {
        const sorted = [...xs].sort((a, b) => a - b);
        return `min=${sorted[0]?.toFixed(1)} median=${sorted[2]?.toFixed(1)} max=${sorted[4]?.toFixed(1)}`;
      };
      console.info(
        `welcome band N=5 deliver→arrival ${fmt(arrivals)} deliver→collapseEnd ${fmt(collapses)}`
      );
      expect(arrivals).toHaveLength(5);
      expect(Math.max(...arrivalFrames)).toBeLessThanOrEqual(ARRIVAL_FRAME_BUDGET);
    },
    120_000
  );

  it.skipIf(!chromiumAvailable)(
    "reduced motion: joy face swap only, no collapse animation; band leaves after the hold, then the phone card",
    async () => {
      const handle = await launchWelcomeHarness({ reducedMotion: true });
      try {
        await handle.page.evaluate(() => window.__welcomeKickoff.onSubscribed());
        await handle.page
          .locator("[data-testid='welcome-kickoff-stage']")
          .waitFor({ state: "attached", timeout: 4000 });
        const measured = await handle.page.evaluate(
          async ({ collapseName }) =>
            await new Promise<{
              collapseStarted: boolean;
              joyFace: string | null;
              bandGoneMs: number;
              deliverMs: number;
              phoneMs: number;
              overlapSeen: boolean;
            }>((resolve, reject) => {
              const timeout = window.setTimeout(
                () => reject(new Error("reduced band did not leave")),
                20_000
              );
              let collapseStarted = false;
              let joyFace: string | null = null;
              let bandGoneMs = 0;
              let overlapSeen = false;
              document.addEventListener(
                "animationstart",
                (event) => {
                  if (event.animationName === collapseName) collapseStarted = true;
                },
                true
              );
              const deliverMs = performance.now();
              const watch = new MutationObserver(() => {
                const band = document.querySelector("[data-testid='welcome-kickoff-stage']");
                const phone = document.querySelector("[data-testid='phone-link-card']");
                if (band && phone) overlapSeen = true;
                if (band?.getAttribute("data-state") === "joy" && joyFace === null) {
                  joyFace =
                    band
                      .querySelector("[data-testid='kometto-face']")
                      ?.getAttribute("data-expression") ?? null;
                }
                if (!band && bandGoneMs === 0) bandGoneMs = performance.now();
                if (phone) {
                  watch.disconnect();
                  window.clearTimeout(timeout);
                  resolve({
                    collapseStarted,
                    joyFace,
                    bandGoneMs,
                    deliverMs,
                    phoneMs: performance.now(),
                    overlapSeen,
                  });
                }
              });
              watch.observe(document.body, {
                subtree: true,
                childList: true,
                attributes: true,
              });
              window.__welcomeKickoff.deliverOpener();
            }),
          { collapseName: WELCOME_KICKOFF_EXIT_ANIMATION_NAME }
        );
        console.info(`welcome band reduced ${JSON.stringify(measured)}`);
        expect(measured.joyFace).toBe("happy");
        expect(measured.collapseStarted).toBe(false);
        expect(measured.bandGoneMs - measured.deliverMs).toBeGreaterThanOrEqual(
          WELCOME_BAND_JOY_HOLD_MS - 20
        );
        expect(measured.overlapSeen).toBe(false);
        expect(measured.phoneMs).toBeGreaterThanOrEqual(measured.bandGoneMs);
      } finally {
        await handle.browser.close();
      }
    },
    40_000
  );
});

/**
 * 「바로 시작한다」의 단위는 밀리초가 아니라 **프레임**이다(#4708). 예전 단정은 `arrivalStartMs - deliverMs < 250` 였다: 브라우저가 CPU 를 못 받는
 * 부하(로드 ~100)에서 439 ms 가 나와 빨개졌다 — 제품의 지연이 아니라 머신의 지연을 잰 것이다. 제품이 약속하는 것은 「밴드를 기다리지 않는다」(밴드의
 * 기쁨 유지는 1200 ms 라서 기다렸다면 수십 프레임이다)이고, 프레임은 머신이 느려져도 같이 늘어나 그 약속을 그대로 잰다. 정상은 1~2 프레임이다.
 */
const ARRIVAL_FRAME_BUDGET = 6;
/** 기쁨 표정과 도착 모션은 같은 커밋에서 선다 — 한두 프레임 안이다. */
const JOY_BESIDE_ARRIVAL_FRAME_BUDGET = 3;

type OpenerPath = {
  deliverMs: number;
  deliverFrame: number;
  arrivalFrame: number;
  joyFrame: number;
  arrivalStartMs: number;
  joyMs: number;
  collapseEndMs: number;
  phoneMs: number;
  overlapSeen: boolean;
  phoneBeforeOpener: boolean;
};

async function measureOpenerPath(
  page: import("playwright").Page
): Promise<OpenerPath> {
  await page.evaluate(() => window.__welcomeKickoff.onSubscribed());
  await page
    .locator("[data-testid='welcome-kickoff-stage']")
    .waitFor({ state: "attached", timeout: 4000 });
  return await page.evaluate(
    async ({ collapseName, arrivalName }) =>
      await new Promise<OpenerPath>((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(new Error("opener path did not complete")),
          20_000
        );
        const phoneBeforeOpener = Boolean(
          document.querySelector("[data-testid='phone-link-card']")
        );
        // 프레임 시계: rAF 콜백이 도는 횟수. 머신이 느려도 제품의 일이 몇 프레임 안에 끝나는지를 잰다.
        let frame = 0;
        const tick = () => {
          frame += 1;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        let arrivalFrame = -1;
        let joyFrame = -1;
        let arrivalStartMs = 0;
        let joyMs = 0;
        let collapseEndMs = 0;
        let overlapSeen = false;
        document.addEventListener(
          "animationstart",
          (event) => {
            if (event.animationName === arrivalName && arrivalStartMs === 0) {
              arrivalStartMs = performance.now();
              arrivalFrame = frame;
            }
          },
          true
        );
        document.addEventListener(
          "animationend",
          (event) => {
            if (event.animationName === collapseName) collapseEndMs = performance.now();
          },
          true
        );
        const deliverMs = performance.now();
        const deliverFrame = frame;
        const watch = new MutationObserver(() => {
          const band = document.querySelector("[data-testid='welcome-kickoff-stage']");
          const phone = document.querySelector("[data-testid='phone-link-card']");
          if (band && phone) overlapSeen = true;
          if (joyMs === 0 && band?.getAttribute("data-state") === "joy") {
            joyMs = performance.now();
            joyFrame = frame;
          }
          if (phone) {
            watch.disconnect();
            window.clearTimeout(timeout);
            resolve({
              deliverMs,
              deliverFrame,
              arrivalFrame,
              joyFrame,
              arrivalStartMs,
              joyMs,
              collapseEndMs,
              phoneMs: performance.now(),
              overlapSeen,
              phoneBeforeOpener,
            });
          }
        });
        watch.observe(document.body, { subtree: true, childList: true, attributes: true });
        window.__welcomeKickoff.deliverOpener();
      }),
    { collapseName: WELCOME_KICKOFF_EXIT_ANIMATION_NAME, arrivalName: ENTER_CONVERSATION_ANIMATION_NAME }
  );
}
