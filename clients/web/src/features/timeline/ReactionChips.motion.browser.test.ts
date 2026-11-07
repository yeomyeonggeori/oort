import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import type { Browser, Locator, Page } from "playwright";
import { ENGINES, type EngineName } from "@/design/appearance/compileTokensTestKit";

// =============================================================================
// 반응 칩의 GIF 는 실제 엔진에서 계속 움직인다 (#5504, owner 2026-11-07 「계속 움직임」). 동작 줄이기는 멈춘 첫 장면, 화면 밖은 멈춤.
//
// 서버 GIF 는 NETSCAPE 반복 횟수가 3(= 총 4번)이라 타이머를 빼는 것만으로는 엔진이 4번째 재생 끝에서 마지막 장면에 멈춘다. 그래서 jsdom 의 「주소가 thumb 으로 안 바뀐다」는 단정만으로는 이 결함에서
// 붉어질 수 없다. 이 시험은 **실제 엔진**(설치된 WebKit·Chromium 전부)이 그린 칩을 **화면 캡처**로 읽는다: 4번 재생이 끝나고도(코어 fixture GIF 는 100ms × 2장면 × 4번 = 800ms) 캡처가 계속 바뀌는가.
// `canvas.drawImage` 는 쓰지 않는다 - 움직이는 GIF 의 첫 장면만 줄 수 있다. 캡처 바이트의 해시가 둘 이상이면 움직이고, 하나뿐이면 멈춘 것이다.
//
// 사보타주: 코어 `loopForever` 가 입력을 그대로 돌려주면(반복 횟수를 안 바꾸면) 「계속 움직인다」 시험이 한 가지 해시로 붉다.
// 엔진이 하나도 없으면 건너뛴다(다른 브라우저 시험과 같은 규약).
// =============================================================================

type Rig = { engine: EngineName; browser: Browser; origin: string };
const rigs: Rig[] = [];
let server: ViteDevServer | null = null;
let cacheDir = "";

beforeAll(async () => {
  if (ENGINES.length === 0) return;
  cacheDir = mkdtempSync(join(tmpdir(), "oort-reaction-chips-vite-"));
  server = await createServer({
    cacheDir,
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
    plugins: [{ name: "reaction-chips-fixture", configureServer(vite) {
      vite.middlewares.use("/__reaction-chips", async (_req, res) => {
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml("/__reaction-chips", `<!doctype html><html lang="ko"><head><style>
          html,body{margin:0}#root{margin:24px}
          #spacer{height:2400px}[data-testid="message-row"]{padding:4px 8px;width:640px}
          </style></head><body><div id="root"></div><script type="module">import {mountReactionChipsHarness} from '/measure/reactionChips.harness.tsx';mountReactionChipsHarness();</script></body></html>`));
      });
    } }],
  });
  await server.listen();
  console.info(`reaction chips: real engines = ${ENGINES.join(", ")}`);
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

const IMAGES = '[data-testid="reaction-chip"] img';
type Harness = { imageCalls: string[]; decodes: number };

async function openHarness(rig: Rig, search: string, options: { reducedMotion?: "reduce" | "no-preference"; height?: number } = {}): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const context = await rig.browser.newContext({ viewport: { width: 900, height: options.height ?? 700 }, locale: "ko-KR", reducedMotion: options.reducedMotion ?? "no-preference" });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${rig.origin}/__reaction-chips${search}`);
  await page.locator(IMAGES).first().waitFor();
  return { page, errors, close: () => context.close() };
}

/** 그려진 칩 그림의 주소(데이터 주소의 앞부분만)와 그려졌는가를 읽는다. */
const sources = (page: Page) => page.evaluate((selector) => [...document.querySelectorAll<HTMLImageElement>(selector)].map((node) => ({ kind: node.src.slice(0, 22), complete: node.complete && node.naturalWidth > 0, src: node.src })), IMAGES);
const harnessOf = (page: Page) => page.evaluate(() => (window as unknown as { reactionChipsHarness: Harness }).reactionChipsHarness);

/** 칩 그림을 `count` 번 캡처해 서로 다른 장면의 수를 센다(바이트 해시). 간격은 장면 지연(100ms)보다 짧지도 같지도 않게 둔다. */
async function distinctScenes(target: Locator, count: number, gapMs: number): Promise<number> {
  const seen = new Set<string>();
  for (let shot = 0; shot < count; shot += 1) {
    seen.add(createHash("sha1").update(await target.screenshot({ animations: "allow" })).digest("hex"));
    await target.page().waitForTimeout(gapMs);
  }
  return seen.size;
}
/** 서로 다른 장면이 `wanted` 가지 보일 때까지 캡처한다(부하가 큰 컴퓨터에서 한 장면에만 걸리는 우연을 견딘다). 못 보면 본 수를 돌려준다. */
async function scenesWithin(target: Locator, wanted: number, deadlineMs: number): Promise<number> {
  const seen = new Set<string>();
  const end = Date.now() + deadlineMs;
  while (Date.now() < end && seen.size < wanted) {
    seen.add(createHash("sha1").update(await target.screenshot({ animations: "allow" })).digest("hex"));
    await target.page().waitForTimeout(37);
  }
  return seen.size;
}

describe("반응 칩의 GIF: 실제 엔진에서 계속 움직인다 (#5504)", () => {
  it.skipIf(ENGINES.length === 0)("4번 재생이 끝난 뒤에도 계속 장면이 바뀐다(주소는 thumb 으로 안 바뀐다)", async () => {
    for (const rig of rigs) {
      const { page, errors, close } = await openHarness(rig, "?chips=1");
      const at = `[${rig.engine}]`;
      try {
        // 움직이는 그림(GIF)이 그려질 때까지, 그리고 코어 fixture GIF 의 4번 재생(800ms)이 한참 지날 때까지 기다린다.
        await page.waitForFunction((selector) => [...document.querySelectorAll<HTMLImageElement>(selector)].every((node) => node.src.startsWith("data:image/gif") && node.complete && node.naturalWidth > 0), IMAGES);
        await page.waitForTimeout(2_500);
        expect((await sources(page)).map((entry) => entry.kind), `${at} 4번 재생 뒤에도 움직이는 그림 주소`).toEqual(["data:image/gif;base64,"]);
        const chip = page.locator(IMAGES).first();
        expect(await scenesWithin(chip, 2, 6_000), `${at} 4번 재생이 끝난 뒤에도 장면이 바뀐다`).toBeGreaterThanOrEqual(2);
        expect(errors, `${at} 페이지 오류`).toEqual([]);
      } finally { await close(); }
    }
  }, 120_000);

  it.skipIf(ENGINES.length === 0)("동작 줄이기: 멈춘 첫 장면(PNG)이고 캡처가 늘 같다", async () => {
    for (const rig of rigs) {
      const { page, errors, close } = await openHarness(rig, "?chips=1", { reducedMotion: "reduce" });
      const at = `[${rig.engine}]`;
      try {
        await page.waitForFunction((selector) => [...document.querySelectorAll<HTMLImageElement>(selector)].every((node) => node.complete && node.naturalWidth > 0), IMAGES);
        await page.waitForTimeout(1_500);
        expect((await sources(page)).map((entry) => entry.kind), `${at} 정지 그림 주소`).toEqual(["data:image/png;base64,"]);
        expect(await distinctScenes(page.locator(IMAGES).first(), 8, 90), `${at} 동작 줄이기에서는 한 장면뿐`).toBe(1);
        // 움직이는 그림을 한 번도 받지 않았다(정지 thumb 만).
        expect((await harnessOf(page)).imageCalls.some((path) => path.includes("size=small")), `${at} small 요청`).toBe(false);
        expect(errors, `${at} 페이지 오류`).toEqual([]);
      } finally { await close(); }
    }
  }, 120_000);

  it.skipIf(ENGINES.length === 0)("화면 밖으로 스크롤하면 멈춘 그림(PNG), 돌아오면 다시 움직이는 그림(GIF)이다", async () => {
    for (const rig of rigs) {
      const { page, errors, close } = await openHarness(rig, "?chips=3&spacer=1");
      const at = `[${rig.engine}]`;
      try {
        // 줄은 2,400px 여백 아래에 있어 처음부터 화면 밖이다: 멈춘 그림.
        await page.waitForFunction((selector) => [...document.querySelectorAll<HTMLImageElement>(selector)].length === 3 && [...document.querySelectorAll<HTMLImageElement>(selector)].every((node) => node.complete && node.naturalWidth > 0), IMAGES);
        expect((await sources(page)).map((entry) => entry.kind), `${at} 화면 밖`).toEqual(Array(3).fill("data:image/png;base64,"));
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForFunction((selector) => [...document.querySelectorAll<HTMLImageElement>(selector)].every((node) => node.src.startsWith("data:image/gif") && node.complete), IMAGES);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForFunction((selector) => [...document.querySelectorAll<HTMLImageElement>(selector)].every((node) => node.src.startsWith("data:image/png")), IMAGES);
        expect(errors, `${at} 페이지 오류`).toEqual([]);
      } finally { await close(); }
    }
  }, 120_000);

  it.skipIf(ENGINES.length === 0)("같은 그림을 쓰는 반응 칩 서른 개는 그림을 한 번만 받고 한 주소를 나눠 쓴다. 서로 다른 그림 서른 장은 서른 번 받는다", async () => {
    for (const rig of rigs) {
      const at = `[${rig.engine}]`;
      // 서른 줄이 모두 화면 안에 들어오게 키 큰 창으로 연다(화면 밖 칩은 설계대로 멈춘 그림이다).
      const same = await openHarness(rig, "?chips=1&rows=30", { height: 1800 });
      try {
        await same.page.waitForFunction((selector) => [...document.querySelectorAll<HTMLImageElement>(selector)].length === 30 && [...document.querySelectorAll<HTMLImageElement>(selector)].every((node) => node.src.startsWith("data:image/gif") && node.complete), IMAGES);
        const entries = await sources(same.page);
        expect(new Set(entries.map((entry) => entry.src)).size, `${at} 서른 칩이 쓰는 주소 수`).toBe(1);
        const calls = (await harnessOf(same.page)).imageCalls;
        expect(calls.filter((path) => path.includes("size=small")), `${at} small 요청`).toHaveLength(1);
        expect(same.errors, `${at} 페이지 오류`).toEqual([]);
      } finally { await same.close(); }
      const distinct = await openHarness(rig, "?chips=30&rows=1");
      try {
        await distinct.page.waitForFunction((selector) => [...document.querySelectorAll<HTMLImageElement>(selector)].length === 30 && [...document.querySelectorAll<HTMLImageElement>(selector)].every((node) => node.src.startsWith("data:image/gif") && node.complete), IMAGES);
        const entries = await sources(distinct.page);
        expect(new Set(entries.map((entry) => entry.src)).size, `${at} 서로 다른 그림 서른 장`).toBe(30);
        expect((await harnessOf(distinct.page)).imageCalls.filter((path) => path.includes("size=small")), `${at} small 요청`).toHaveLength(30);
        expect(distinct.errors, `${at} 페이지 오류`).toEqual([]);
      } finally { await distinct.close(); }
    }
  }, 180_000);
});

// -----------------------------------------------------------------------------
// 프레임 측정 (#5504): 반응이 서른 개 달린 메시지에서 requestAnimationFrame 간격과(Chromium 은) 메인 스레드 바쁨을 잰다. 숫자는 `console.info` 로 남기고(인계에 옮긴다), 단정은 「측정이 돌았다」뿐이다 -
// 프레임 시간은 이 컴퓨터가 얼마나 바쁜지에 따라 흔들려서 시간 문턱을 단정하면 거짓으로 붉어진다. 비교 기준은 같은 서른 개가 정지 그림일 때의 숫자다.
// 길어서(엔진마다 약 20초) 기본 시험에는 넣지 않는다: `REACTION_FRAMES=1 npx vitest run src/features/timeline/ReactionChips.motion.browser.test.ts` 로 돌린다.
// -----------------------------------------------------------------------------
const MEASURE = process.env.REACTION_FRAMES === "1";
async function frameStats(page: Page, windowMs: number) {
  return page.evaluate((span) => new Promise<{ frames: number; meanMs: number; p95Ms: number; maxMs: number; over33: number; over50: number }>((resolve) => {
    const gaps: number[] = [];
    let last = performance.now();
    const start = last;
    const tick = (now: number) => {
      gaps.push(now - last);
      last = now;
      if (now - start < span) requestAnimationFrame(tick);
      else {
        const sorted = [...gaps].sort((a, b) => a - b);
        const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
        resolve({ frames: gaps.length, meanMs: mean, p95Ms: sorted[Math.floor(sorted.length * 0.95)], maxMs: sorted[sorted.length - 1], over33: gaps.filter((gap) => gap > 33.4).length, over50: gaps.filter((gap) => gap > 50).length });
      }
    };
    requestAnimationFrame(tick);
  }), windowMs);
}
const fmt = (stats: Awaited<ReturnType<typeof frameStats>>) => `frames=${stats.frames} mean=${stats.meanMs.toFixed(2)}ms p95=${stats.p95Ms.toFixed(2)}ms max=${stats.maxMs.toFixed(2)}ms over33ms=${stats.over33} over50ms=${stats.over50}`;

/**
 * Chromium 만: 개발자 도구 프로토콜의 메인 스레드 일한 시간(`TaskDuration`, 켠 뒤로 쌓이는 초) - 구간 앞뒤의 차를 구간 길이로 나누면 메인 스레드 사용률이다.
 * 세션은 구간 내내 하나를 쓴다(읽을 때마다 새로 켜면 합이 0 에서 다시 시작해 차가 의미를 잃는다).
 */
async function measureWindow(page: Page, engine: EngineName, windowMs: number) {
  const session = engine === "chromium" ? await page.context().newCDPSession(page) : null;
  const busyNow = async () => (await session!.send("Performance.getMetrics")).metrics.find((metric) => metric.name === "TaskDuration")?.value ?? null;
  if (session) await session.send("Performance.enable");
  const before = session ? await busyNow() : null;
  const stats = await frameStats(page, windowMs);
  const after = session ? await busyNow() : null;
  await session?.detach();
  const busy = before !== null && after !== null ? `mainThreadBusy=${(((after - before) / (windowMs / 1000)) * 100).toFixed(1)}%` : "mainThreadBusy=n/a(WebKit)";
  return { stats, text: `${fmt(stats)} ${busy}` };
}
const allDrawn = (page: Page, count: number, kind: string) => page.waitForFunction(([selector, wanted, prefix]) => {
  const nodes = [...document.querySelectorAll<HTMLImageElement>(selector as string)];
  return nodes.length === wanted && nodes.every((node) => node.src.startsWith(prefix as string) && node.complete && node.naturalWidth > 0);
}, [IMAGES, count, kind] as const);

describe("반응이 서른 개 달린 메시지의 프레임 (#5504, 숫자는 인계에 옮긴다)", () => {
  it.skipIf(ENGINES.length === 0 || !MEASURE)("서른 칩이 모두 움직이는 동안의 프레임·메인 스레드를 정지 서른 개와 같은 그림 서른 줄에 견줘 잰다", async () => {
    // 한 번에 한 페이지만 연다: 다른 페이지의 서른 칩이 같이 움직이면 숫자가 서로의 부하를 섞어 쥔다.
    async function run(rig: Rig, search: string, options: { reducedMotion?: "reduce"; height?: number }, drawn: string, warmMs: number) {
      const harness = await openHarness(rig, search, options);
      try {
        await allDrawn(harness.page, 30, drawn);
        await harness.page.waitForTimeout(warmMs);
        const measured = await measureWindow(harness.page, rig.engine, 5_000);
        const smalls = (await harnessOf(harness.page)).imageCalls.filter((path) => path.includes("size=small")).length;
        expect(harness.errors, `[${rig.engine}] 페이지 오류`).toEqual([]);
        expect(measured.stats.frames, `[${rig.engine}] 측정이 돌았다`).toBeGreaterThan(30);
        return { ...measured, smalls };
      } finally { await harness.close(); }
    }
    for (const rig of rigs) {
      const at = `[${rig.engine}]`;
      // 4번 재생(12장면 × 80ms × 4 = 3.84초)이 지난 뒤에도 움직이는 구간을 재려고 5초를 기다렸다가 5초 잰다.
      const distinct = await run(rig, "?chips=30&rows=1&gif=synth", { height: 900 }, "data:image/gif", 5_000);
      const shared = await run(rig, "?chips=1&rows=30&gif=synth", { height: 1800 }, "data:image/gif", 5_000);
      const still = await run(rig, "?chips=30&rows=1&gif=synth", { reducedMotion: "reduce", height: 900 }, "data:image/png", 1_000);
      console.info(`reaction frames ${at} A 서로 다른 128px GIF 칩 30개(움직임, 4번 재생 뒤): ${distinct.text} | small 요청 ${distinct.smalls}`);
      console.info(`reaction frames ${at} B 같은 GIF 칩 30줄(움직임, 한 주소 공유):          ${shared.text} | small 요청 ${shared.smalls}`);
      console.info(`reaction frames ${at} C 같은 서른 개 동작 줄이기(정지 PNG 기준):          ${still.text} | small 요청 ${still.smalls}`);
    }
  }, 300_000);
});
