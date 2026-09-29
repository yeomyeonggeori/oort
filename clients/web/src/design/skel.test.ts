import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compile } from "tailwindcss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EmptyInvite, Skeleton } from "../features/common/States";

/**
 * UX-R1c / ADR-0179 D3 — skeleton → content blur crossfade.
 *
 * Browser-free half (always runs, including CI): compiled `@utility skel`
 * CSS and call-site bindings. A missing Chromium cannot hide those.
 *
 * Playwright half (skipIf, loud): runtime geometry and transition counts.
 * GitHub Actions `vitest` does not run `playwright install`, and `.github/**`
 * is out of this ticket. Missing package or missing executable → skip
 * (never a silent green: warn + skipIf). Never skip the file as a whole.
 *
 * red proof (scratch, product):
 *   - rename skel-content / skel-bars in States.tsx → computed overlay gone
 *     (browser-free name scan AND runtime class probe)
 *   - h-6 → h-12 on the bar → row height is not 24
 *   - static markup (M3b): duplicate the content layer → .skel-content count ≠ 1
 *   - runtime re-flip (M3d): effect toggles data-ready 300ms after arrival →
 *     React-mounted content opacity transitionrun ≠ 1 (static setAttribute
 *     cases cannot see this; they never run React)
 *   - move the Inbox list outside the Skeleton (tag left in place) →
 *     mounted InboxRoute.skel host.contains(list) is false
 *   - leave bars in flow after ready → host height > content height
 *   - restore skel-pulse → animation-name is not none
 *   - collapse host height only on is-settled (R3) → per-frame |Δh| is 48/76
 *   - measure `from` on the shared cell after content commit (R4) → grow
 *     cases land +14/+224 in the flip frame and heightTransitionEnd is -1
 *   - sample only after the click (old trace) → that same grow jump is
 *     before sample 0, so maxStep=0 and the ladder looks closed
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, "..", "..");
const SRC = resolve(WEB_ROOT, "src");
const CORE_SRC = resolve(WEB_ROOT, "../../packages/momo-core/src");
const HARNESS = resolve(WEB_ROOT, "measure/skel.harness.tsx");
const require_ = createRequire(import.meta.url);
const TOKENS_CSS = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const STATES_SRC = readFileSync(
  new URL("../features/common/States.tsx", import.meta.url),
  "utf8"
);
const DRAFTS_SRC = readFileSync(
  new URL("../features/drafts/DraftsRoute.tsx", import.meta.url),
  "utf8"
);
const ACTIVITY_SRC = readFileSync(
  new URL("../features/activity/ActivityRoute.tsx", import.meta.url),
  "utf8"
);
const SIDEBAR_SRC = readFileSync(
  new URL("../features/sidebar/Sidebar.tsx", import.meta.url),
  "utf8"
);

/**
 * Runtime probes need a Playwright Chromium binary. Local gates and the
 * design-review lane have it; GitHub Actions `vitest` does not run
 * `playwright install`, and `.github/**` is out of this ticket. Missing
 * package or missing executable → skip (never a silent green: warn + skipIf).
 */
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
    `skel runtime proofs skipped: Playwright Chromium executable missing (${chromiumAvailability.path}). Compiled-CSS and call-site assertions still run.`
  );
}

async function loadStylesheet(id: string, base: string) {
  if (id === "tailwindcss" || id.endsWith("tailwindcss/index.css")) {
    const path = require_.resolve("tailwindcss/index.css");
    return { path, base: dirname(path), content: readFileSync(path, "utf8") };
  }
  const path = id.startsWith(".") || id.startsWith("/") ? `${base}/${id}` : id;
  return { path, base: dirname(path), content: readFileSync(path, "utf8") };
}

// #3100: the compiled CSS is a pure function of the candidate list, and the
// Tailwind compile is the dominant per-test cost under CPU contention (it sat
// inside the 20s per-test budget). Memoize per file; output is byte-identical.
const cssCache = new Map<string, Promise<string>>();
function buildCss(candidates: string[]): Promise<string> {
  const key = candidates.join("\u0000");
  let hit = cssCache.get(key);
  if (!hit) {
    hit = (async () => {
      const compiler = await compile(TOKENS_CSS, { base: HERE, loadStylesheet });
      return compiler.build(candidates);
    })();
    cssCache.set(key, hit);
  }
  return hit;
}

// #3100: one Chromium per file instead of one per test. Launch is paid in the
// hook (own budget), not inside a test's 20s timeout; every test still gets a
// fresh context+page, so no state is shared between cases.
let sharedBrowser: Promise<import("playwright").Browser> | null = null;
function getBrowser(): Promise<import("playwright").Browser> {
  if (!sharedBrowser) {
    sharedBrowser = import("playwright").then(({ chromium }) => chromium.launch());
  }
  return sharedBrowser;
}
beforeAll(async () => {
  if (!chromiumAvailable) return;
  await getBrowser();
}, 120_000);
afterAll(async () => {
  if (!sharedBrowser) return;
  const browser = await sharedBrowser;
  sharedBrowser = null;
  await browser.close();
}, 60_000);

const SKEL_CANDIDATES = [
  "skel",
  "skel-layer",
  "skel-bars",
  "skel-content",
  "flex",
  "flex-col",
  "gap-2",
  "gap-3",
  "p-2",
  "p-4",
  "px-2",
  "px-4",
  "py-1",
  "py-6",
  "h-6",
  "rounded-sm",
  "bg-surface-hover",
  "text-body",
  "text-meta",
  "font-medium",
  "text-ink",
  "text-ink-muted",
  "break-keep",
  "items-start",
];

type CallSite = "sidebar" | "drafts" | "activity";

function callSiteChildren(site: CallSite) {
  if (site === "sidebar") {
    return createElement(
      "ul",
      { className: "flex flex-col" },
      createElement("li", { className: "px-2 py-1 text-body" }, "엔진"),
      createElement("li", { className: "px-2 py-1 text-body" }, "일반")
    );
  }
  if (site === "drafts") {
    return createElement(EmptyInvite, {
      headline: "아직 초안이 없습니다.",
      detail: "쓰다 만 글은 자동으로 저장됩니다.",
      testId: "drafts-empty",
    });
  }
  return createElement(EmptyInvite, {
    headline: "에이전트 활동이 아직 없습니다.",
    detail:
      "에이전트가 실행 허가를 요청하거나 작업을 마치면 한 줄씩 쌓입니다. 담당자도 함께 표시됩니다.",
    testId: "activity-empty",
  });
}

function productMarkup(ready: boolean, site: CallSite = "sidebar"): string {
  const rows = site === "sidebar" ? 4 : 4;
  const className = site === "sidebar" ? undefined : "p-4";
  return renderToStaticMarkup(
    createElement(
      Skeleton,
      { ready, rows, className },
      callSiteChildren(site)
    )
  );
}

async function withSkelPage(
  options: {
    reducedMotion?: "reduce" | "no-preference";
    ready?: boolean;
    site?: CallSite;
  },
  run: (page: import("playwright").Page) => Promise<void>
): Promise<void> {
  const css = await buildCss(SKEL_CANDIDATES);
  const browser = await getBrowser();
  const context = await browser.newContext({
    reducedMotion: options.reducedMotion ?? "no-preference",
  });
  try {
    const page = await context.newPage();
    const markup = productMarkup(options.ready ?? false, options.site ?? "sidebar");
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head><body>${markup}</body></html>`
    );
    await run(page);
  } finally {
    await context.close();
  }
}

let harnessBundle: Promise<string> | null = null;
function harnessJs(): Promise<string> {
  harnessBundle ??= (async () => {
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
      logLevel: "silent",
    });
    const js = bundled.outputFiles[0]?.text;
    if (!js) throw new Error("esbuild produced no skel harness");
    return js;
  })();
  return harnessBundle;
}

async function withReactSkelPage(
  options: {
    reducedMotion?: "reduce" | "no-preference";
    viewport?: { width: number; height: number };
  },
  run: (page: import("playwright").Page) => Promise<void>
): Promise<void> {
  const js = await harnessJs();
  const css = await buildCss(SKEL_CANDIDATES);
  const browser = await getBrowser();
  const context = await browser.newContext({
    reducedMotion: options.reducedMotion ?? "no-preference",
    viewport: options.viewport,
  });
  try {
    const page = await context.newPage();
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`
    );
    await page.getByTestId("skel-arrive").waitFor({ state: "visible" });
    await run(page);
  } finally {
    await context.close();
  }
}

type HeightSample = {
  t: number;
  h: number;
  content: number;
  settled: boolean;
};

type HeightTrace = {
  samples: HeightSample[];
  heightTransitionEnd: number;
  opacityTransitionEnd: number;
};

type TraceShape = "sidebar" | "drafts" | "sidebar5" | "sidebar12";

const TRACE_ARRIVE: Record<TraceShape, string> = {
  sidebar: "skel-arrive",
  drafts: "skel-arrive-drafts",
  sidebar5: "skel-arrive-sidebar5",
  sidebar12: "skel-arrive-sidebar12",
};

/**
 * Per-frame host height across the crossfade. R3-H1 / R4-H1: a repair that
 * is right at the endpoints and wrong in its timing is still a pop, and a
 * trace that starts after the flip cannot see a one-frame grow.
 *
 * Sample 0 is the pre-flip height. The rAF loop starts first; the click
 * runs on the next frame so the flip is inside the window. `flip-then-sample`
 * is the R4 guard (click, then sample from the next rAF) — kept only so a
 * scratch copy can show it missing the grow jump.
 */
async function traceHostHeight(
  page: import("playwright").Page,
  shape: TraceShape,
  mode: "sample-then-flip" | "flip-then-sample" = "sample-then-flip"
): Promise<HeightTrace> {
  const arrive = TRACE_ARRIVE[shape];
  return page.evaluate(async (args) => {
    const section = document.querySelector(
      `[data-skel-shape="${args.shape}"]`
    );
    const host = section?.querySelector(
      '[data-testid="skeleton"]'
    ) as HTMLElement | null;
    const button = document.querySelector(
      `[data-testid="${args.arrive}"]`
    ) as HTMLButtonElement | null;
    if (!host || !button) throw new Error("height trace: shape not mounted");
    const bars = host.querySelector('[data-skel="bars"]') as HTMLElement | null;
    const samples: HeightSample[] = [];
    let heightTransitionEnd = -1;
    let opacityTransitionEnd = -1;
    const t0 = performance.now();
    const markEnd = (event: TransitionEvent) => {
      if (event.target !== event.currentTarget) return;
      const elapsed = performance.now() - t0;
      if (event.propertyName === "height") heightTransitionEnd = elapsed;
      if (event.propertyName === "opacity") opacityTransitionEnd = elapsed;
    };
    bars?.addEventListener("transitionend", markEnd);
    host.addEventListener("transitionend", markEnd);

    const pushSample = () => {
      const now = performance.now() - t0;
      const content = host.querySelector(
        '[data-skel="content"]'
      ) as HTMLElement | null;
      samples.push({
        t: Math.round(now),
        h: Math.round(host.getBoundingClientRect().height),
        content: Math.round(content?.getBoundingClientRect().height ?? 0),
        settled: host.classList.contains("is-settled"),
      });
      return now;
    };

    if (args.mode === "flip-then-sample") {
      button.click();
      await new Promise<void>((done) => {
        const tick = () => {
          const now = pushSample();
          if (now > 700) return done();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    } else {
      await new Promise<void>((done) => {
        let flipped = false;
        const tick = () => {
          const now = pushSample();
          if (!flipped) {
            flipped = true;
            button.click();
          }
          if (now > 700) return done();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    }
    return {
      samples,
      heightTransitionEnd: Math.round(heightTransitionEnd),
      opacityTransitionEnd: Math.round(opacityTransitionEnd),
    };
  }, { shape, arrive, mode });
}

/**
 * #3100: the ladder asserts a per-FRAME step (|Δh| ≤ 12px per frame), which
 * is only a statement about the product when frames arrive at display
 * cadence. A starved renderer skips frames and the same smooth transition
 * shows a bigger step (measured under load: 13/14/15/17 vs cap 12). A trace
 * with a frame gap above STARVED_FRAME_MS therefore says nothing about the
 * product and is re-taken on a fresh page (up to TRACE_ATTEMPTS). Unlike a
 * looser cap this cannot hide a real pop: a product that jumps fails on every
 * clean-cadence attempt, and if no attempt is clean the last one is asserted
 * as-is (it fails loudly, it is never skipped).
 */
const STARVED_FRAME_MS = 40;
const TRACE_ATTEMPTS = 6;

function maxFrameGap(trace: HeightTrace): number {
  let gap = 0;
  for (let i = 1; i < trace.samples.length; i += 1) {
    gap = Math.max(gap, trace.samples[i]!.t - trace.samples[i - 1]!.t);
  }
  return gap;
}

async function traceCleanCadence(
  shape: TraceShape,
  viewport: { width: number; height: number }
): Promise<HeightTrace> {
  let last: HeightTrace | null = null;
  for (let attempt = 0; attempt < TRACE_ATTEMPTS; attempt += 1) {
    await withReactSkelPage({ viewport }, async (page) => {
      last = await traceHostHeight(page, shape);
    });
    if (maxFrameGap(last!) <= STARVED_FRAME_MS) return last!;
  }
  return last!;
}

function formatTrace(samples: HeightSample[]): string {
  return samples
    .filter(
      (s, i) =>
        i === 0 ||
        s.h !== samples[i - 1]!.h ||
        s.settled !== samples[i - 1]!.settled
    )
    .map((s) => `t=${s.t} h=${s.h} content=${s.content} settled=${s.settled}`)
    .join("\n");
}

function nearestSampleIndex(samples: HeightSample[], t: number): number {
  let best = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if (Math.abs(samples[i]!.t - t) < Math.abs(samples[best]!.t - t)) {
      best = i;
    }
  }
  return best;
}

function assertHeightLadder(
  trace: HeightTrace,
  label: string,
  maxStepCap = 12
): void {
  const { samples, heightTransitionEnd, opacityTransitionEnd } = trace;
  expect(samples.length, `${label}: no frames`).toBeGreaterThan(4);
  const compact = formatTrace(samples);
  const deltas: number[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    deltas.push(samples[i]!.h - samples[i - 1]!.h);
  }
  const maxStep = Math.max(0, ...deltas.map((d) => Math.abs(d)));
  expect(
    maxStep,
    `${label}: max single-frame |Δh|=${maxStep} (cap ${maxStepCap})\n${compact}`
  ).toBeLessThanOrEqual(maxStepCap);

  const first = samples[0]!.h;
  const last = samples[samples.length - 1]!.h;
  const shrink = last <= first;
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1]!.h;
    const next = samples[i]!.h;
    if (shrink) {
      expect(
        next,
        `${label}: height rose ${prev}→${next} at t=${samples[i]!.t} (must be monotonic shrink)\n${compact}`
      ).toBeLessThanOrEqual(prev);
    } else {
      expect(
        next,
        `${label}: height fell ${prev}→${next} at t=${samples[i]!.t} (must be monotonic grow)\n${compact}`
      ).toBeGreaterThanOrEqual(prev);
    }
  }

  const settledAt = samples.findIndex((s) => s.settled);
  expect(settledAt, `${label}: never settled\n${compact}`).toBeGreaterThan(0);
  const settledHeight = samples[settledAt]!.h;
  for (let i = settledAt; i < samples.length; i += 1) {
    expect(
      samples[i]!.h,
      `${label}: height moved after is-settled (t=${samples[i]!.t} ${settledHeight}→${samples[i]!.h})\n${compact}`
    ).toBe(settledHeight);
  }

  expect(
    heightTransitionEnd,
    `${label}: heightTransitionEnd never fired\n${compact}`
  ).toBeGreaterThanOrEqual(0);
  expect(
    opacityTransitionEnd,
    `${label}: opacityTransitionEnd never fired\n${compact}`
  ).toBeGreaterThanOrEqual(0);
  const heightEndAt = nearestSampleIndex(samples, heightTransitionEnd);
  const opacityEndAt = nearestSampleIndex(samples, opacityTransitionEnd);
  expect(
    Math.abs(heightEndAt - opacityEndAt),
    `${label}: height end frame ${heightEndAt} (t=${heightTransitionEnd}) vs opacity end frame ${opacityEndAt} (t=${opacityTransitionEnd}) (±1)\n${compact}`
  ).toBeLessThanOrEqual(1);

  const lastEnd = Math.max(heightTransitionEnd, opacityTransitionEnd);
  const afterEnd = samples.filter((s) => s.t > lastEnd);
  expect(
    afterEnd.length,
    `${label}: no samples after transitionend t=${lastEnd}\n${compact}`
  ).toBeGreaterThan(0);
  const heightAfterEnd = afterEnd[0]!.h;
  for (const sample of afterEnd) {
    expect(
      sample.h,
      `${label}: height moved after last transitionend (t=${sample.t} ${heightAfterEnd}→${sample.h}, end=${lastEnd})\n${compact}`
    ).toBe(heightAfterEnd);
  }

  const end = samples[samples.length - 1]!;
  expect(
    end.h,
    `${label}: final host ${end.h} !== content ${end.content}\n${compact}`
  ).toBe(end.content);
}

type TransitionProbe = { propertyName: string; type: string };

async function armTransitionProbe(
  page: import("playwright").Page,
  selector: string
): Promise<void> {
  await page.locator(selector).evaluate((node) => {
    const target = node as HTMLElement & { __ev: TransitionProbe[] };
    target.__ev = [];
    for (const type of ["transitionrun", "transitionstart"] as const) {
      node.addEventListener(type, (event) => {
        if (event.target !== node) return;
        target.__ev.push({
          type,
          propertyName: (event as TransitionEvent).propertyName,
        });
      });
    }
  });
}

async function readProbe(
  page: import("playwright").Page,
  selector: string
): Promise<TransitionProbe[]> {
  return page.locator(selector).evaluate(
    (node) => (node as HTMLElement & { __ev: TransitionProbe[] }).__ev ?? []
  );
}

/**
 * #3100: replaces `waitForTimeout(400)` before counting transition events.
 * A fixed wall-clock window measured the machine: under load the transition
 * had not even started 400ms after the flip, so a count of 1 read as 0. Wait
 * on the page's own clock instead: two frames (style recalc has run, so every
 * transition the flip causes has fired `transitionrun`), then until the
 * element's own transitions have finished, then two more frames.
 */
async function settleTransitions(
  page: import("playwright").Page,
  selector: string
): Promise<void> {
  await page.locator(selector).evaluate(async (node) => {
    const frames = (n: number) =>
      new Promise<void>((done) => {
        const step = (left: number) =>
          left <= 0 ? done() : requestAnimationFrame(() => step(left - 1));
        step(n);
      });
    await frames(2);
    await Promise.all(
      node.getAnimations().map((animation) => animation.finished.catch(() => undefined))
    );
    await frames(2);
  });
}

async function setReady(
  page: import("playwright").Page,
  ready: boolean
): Promise<void> {
  await page.locator('[data-testid="skeleton"]').evaluate((node, next) => {
    node.setAttribute("data-ready", next ? "true" : "false");
  }, ready);
}

async function measureHost(page: import("playwright").Page) {
  return page.locator('[data-testid="skeleton"]').evaluate((node) => {
    const host = node as HTMLElement;
    const bars = host.querySelector('[data-skel="bars"]') as HTMLElement | null;
    const content = host.querySelector(
      '[data-skel="content"]'
    ) as HTMLElement | null;
    return {
      host: host.getBoundingClientRect().height,
      bars: bars?.getBoundingClientRect().height ?? 0,
      content: content?.getBoundingClientRect().height ?? 0,
      contentClass: content?.className ?? "",
      barsClass: bars?.className ?? "",
      settled: host.classList.contains("is-settled"),
    };
  });
}

describe("UX-R1c @utility skel CSS", () => {
  it("tokens.css declares @utility skel", () => {
    expect(TOKENS_CSS).toMatch(/@utility skel\b/);
  });

  it("compiled .skel is a grid containing block (one cell, not a column stack)", async () => {
    const css = await buildCss(["skel"]);
    expect(css).toMatch(/\.skel\s*\{[^}]*display:\s*grid/);
    expect(css).toMatch(/\.skel\s*\{[^}]*position:\s*relative/);
  });

  it("content reveal uses --motion-blur-arrival (not a new blur token)", async () => {
    const css = await buildCss(SKEL_CANDIDATES);
    const rule = css.match(/\.skel-content[^{]*\{[^}]+\}/);
    expect(rule?.[0], "skel-content rule").toMatch(
      /blur\(\s*var\(--motion-blur-arrival\)/
    );
    expect(css).not.toMatch(/--skel-reveal-blur/);
  });

  it("crossfade duration and easing are the standard ladder tokens", async () => {
    const css = await buildCss(SKEL_CANDIDATES);
    const rule = css.match(/\.skel-content[^{]*\{[^}]+\}/);
    expect(rule?.[0], "skel-content rule").toMatch(/var\(--motion-standard\)/);
    expect(rule?.[0]).toMatch(/var\(--motion-ease-standard\)/);
  });

  it("is-resetting zeros transitions (transition: none)", async () => {
    const css = await buildCss(SKEL_CANDIDATES);
    expect(css).toMatch(/\.skel\.is-resetting[\s\S]{0,280}transition:\s*none/);
  });

  it("is-settled takes bars out of flow (no pulse keyframes)", async () => {
    const css = await buildCss(SKEL_CANDIDATES);
    expect(css).toMatch(/\.skel\.is-settled[\s\S]{0,200}position:\s*absolute/);
    expect(css).not.toMatch(/skel-pulse/);
  });

  it("is-sizing interpolates host height on the standard ladder", async () => {
    const css = await buildCss(SKEL_CANDIDATES);
    expect(css).toMatch(
      /\.skel\.is-sizing[\s\S]{0,220}height[\s\S]{0,80}var\(--motion-standard\)/
    );
    expect(css).toMatch(
      /\.skel\.is-sizing[\s\S]{0,220}var\(--motion-ease-standard\)/
    );
  });

  it("is-sizing clips the bars overhang (overflow: hidden)", async () => {
    const css = await buildCss(SKEL_CANDIDATES);
    expect(css).toMatch(/\.skel\.is-sizing[\s\S]{0,160}overflow:\s*hidden/);
  });

  it("skel-layer has min-width: 0 (grid min-content floor)", async () => {
    const css = await buildCss(["skel-layer"]);
    expect(css).toMatch(/\.skel-layer[\s\S]{0,120}min-width:\s*0/);
  });
});

describe("UX-R1c product binding — real Skeleton markup", () => {
  it("States.tsx paints skel-content and skel-bars (rename turns this red)", () => {
    expect(STATES_SRC).toMatch(/className=\{cn\(\s*"skel-layer skel-bars/);
    expect(STATES_SRC).toMatch(/className="skel-layer skel-content"/);
    expect(STATES_SRC).toMatch(/className="h-6 rounded-sm bg-surface-hover"/);
    expect(STATES_SRC).toMatch(/classList\.add\("is-sizing"\)/);
    expect(STATES_SRC).toMatch(/style\.height/);
    expect(STATES_SRC).toMatch(/lastBarsHeight/);
    expect(STATES_SRC).toMatch(/useLayoutEffect/);
    expect(STATES_SRC).toMatch(/setTimeout\(\s*finish,\s*400\s*\)/);
  });

  it("Drafts and Activity empty states sit inside <Skeleton> (source guard)", () => {
    expect(DRAFTS_SRC).toMatch(/<Skeleton[\s>]/);
    expect(DRAFTS_SRC).toMatch(
      /<Skeleton[\s\S]*?data-testid="drafts-empty"[\s\S]*?<\/Skeleton>/
    );
    expect(ACTIVITY_SRC).toMatch(/<Skeleton[\s>]/);
    expect(ACTIVITY_SRC).toMatch(
      /<Skeleton[\s\S]*?testId="activity-empty"[\s\S]*?<\/Skeleton>/
    );
  });

  it("sidebar channel sections pass wrapList={false} (ul is not a Skeleton child of ul)", () => {
    expect(SIDEBAR_SRC).toContain("wrapList={false}");
  });
});

describe("UX-R1c runtime — one number per case, product host", () => {
  it.skipIf(!chromiumAvailable)(
    "ready false→true: content opacity transitionrun count is 1 (static markup)",
    async () => {
      await withSkelPage({}, async (page) => {
        expect(await page.locator(".skel-content").count()).toBe(1);
        await armTransitionProbe(page, '[data-skel="content"]');
        await setReady(page, true);
        await settleTransitions(page, '[data-skel="content"]');
        const events = await readProbe(page, '[data-skel="content"]');
        const count = events.filter(
          (event) => event.type === "transitionrun" && event.propertyName === "opacity"
        ).length;
        expect(count, `events=${JSON.stringify(events)}`).toBe(1);
      });
    },
    20_000
  );

  it.skipIf(!chromiumAvailable)(
    "ready false→true: content filter transitionrun count is 1 (static markup)",
    async () => {
      await withSkelPage({}, async (page) => {
        await armTransitionProbe(page, '[data-skel="content"]');
        await setReady(page, true);
        await settleTransitions(page, '[data-skel="content"]');
        const events = await readProbe(page, '[data-skel="content"]');
        const count = events.filter(
          (event) => event.type === "transitionrun" && event.propertyName === "filter"
        ).length;
        expect(count, `events=${JSON.stringify(events)}`).toBe(1);
      });
    },
    20_000
  );

  it.skipIf(!chromiumAvailable)(
    "content transition-duration is the standard ladder (0.24s)",
    async () => {
      await withSkelPage({}, async (page) => {
        const duration = await page
          .locator('[data-skel="content"]')
          .evaluate(
            (node) =>
              getComputedStyle(node as HTMLElement).transitionDuration
          );
        const first = duration.split(",")[0]?.trim();
        expect(first, `transitionDuration=${duration}`).toBe("0.24s");
      });
    },
    20_000
  );

  it.skipIf(!chromiumAvailable)(
    "product classes drive the overlay (rename in States.tsx turns this red)",
    async () => {
      await withSkelPage({}, async (page) => {
        const box = await measureHost(page);
        expect(box.contentClass).toContain("skel-content");
        expect(box.barsClass).toContain("skel-bars");
        const opacity = await page
          .locator(".skel-content")
          .evaluate((node) => getComputedStyle(node as HTMLElement).opacity);
        expect(opacity, "unmatched .skel-content would paint at 1").toBe("0");
      });
    },
    20_000
  );

  it.skipIf(!chromiumAvailable)(
    "each bar is h-6 (24px) — doubling the bar class turns this red",
    async () => {
      await withSkelPage({}, async (page) => {
        const height = await page
          .locator('[data-testid="skeleton-row"]')
          .first()
          .evaluate((node) => (node as HTMLElement).getBoundingClientRect().height);
        expect(height).toBe(24);
      });
    },
    20_000
  );

  it.skipIf(!chromiumAvailable)(
    "loading: wrapper height equals the bars layer, not the sum",
    async () => {
      await withSkelPage({ site: "sidebar" }, async (page) => {
        const box = await measureHost(page);
        expect(box.bars).toBeGreaterThan(0);
        expect(box.host).toBe(box.bars);
        expect(box.host).not.toBe(box.bars + box.content);
      });
    },
    20_000
  );

  it.skipIf(!chromiumAvailable)(
    "sidebar settled: host height equals content height (not a bars floor)",
    async () => {
      await withSkelPage({ ready: true, site: "sidebar" }, async (page) => {
        const box = await measureHost(page);
        expect(box.settled, "SSR ready=true must ship is-settled").toBe(true);
        expect(box.content).toBeGreaterThan(0);
        expect(box.host).toBe(box.content);
        expect(box.bars).toBe(0);
      });
    },
    20_000
  );

  it.skipIf(!chromiumAvailable)(
    "Drafts empty settled: host height equals content height",
    async () => {
      await withSkelPage({ ready: true, site: "drafts" }, async (page) => {
        const box = await measureHost(page);
        expect(box.settled).toBe(true);
        expect(await page.locator('[data-testid="drafts-empty"]').count()).toBe(
          1
        );
        expect(box.host).toBe(box.content);
        expect(box.bars).toBe(0);
      });
    },
    20_000
  );

  it.skipIf(!chromiumAvailable)(
    "Activity empty settled: host height equals content height",
    async () => {
      await withSkelPage({ ready: true, site: "activity" }, async (page) => {
        const box = await measureHost(page);
        expect(box.settled).toBe(true);
        expect(
          await page.locator('[data-testid="activity-empty"]').count()
        ).toBe(1);
        expect(box.host).toBe(box.content);
        expect(box.bars).toBe(0);
      });
    },
    20_000
  );

  it.skipIf(!chromiumAvailable)(
    "is-resetting: content transitionrun count is 0",
    async () => {
      await withSkelPage({}, async (page) => {
        await page.locator('[data-testid="skeleton"]').evaluate((node) => {
          node.classList.add("is-resetting");
        });
        await armTransitionProbe(page, '[data-skel="content"]');
        await setReady(page, true);
        await settleTransitions(page, '[data-skel="content"]');
        const events = await readProbe(page, '[data-skel="content"]');
        const count = events.filter((event) => event.type === "transitionrun")
          .length;
        expect(count, `events=${JSON.stringify(events)}`).toBe(0);
      });
    },
    20_000
  );

  it.skipIf(!chromiumAvailable)(
    "reduced-motion via the D9 ladder: content transitionrun 0",
    async () => {
      await withSkelPage({ reducedMotion: "reduce" }, async (page) => {
        await armTransitionProbe(page, '[data-skel="content"]');
        await setReady(page, true);
        await settleTransitions(page, '[data-skel="content"]');
        const events = await readProbe(page, '[data-skel="content"]');
        const count = events.filter((event) => event.type === "transitionrun")
          .length;
        expect(count, `events=${JSON.stringify(events)}`).toBe(0);
      });
    },
    20_000
  );

  it.skipIf(!chromiumAvailable)(
    "bars have no pulse animation",
    async () => {
      await withSkelPage({}, async (page) => {
        const pulse = await page.locator('[data-skel="bars"]').evaluate((node) => {
          const style = getComputedStyle(node as HTMLElement);
          return {
            name: style.animationName,
            playState: style.animationPlayState,
          };
        });
        expect(pulse.name).toBe("none");
      });
    },
    20_000
  );
});

describe("UX-R1c runtime — React-mounted Skeleton (ready via state)", () => {
  it.skipIf(!chromiumAvailable)(
    "React ready false→true: content opacity and filter transitionrun are 1; is-settled after transitionend",
    async () => {
      // #3100: is-settled has two legitimate triggers, bars' opacity
      // transitionend and a 400ms fallback timer. When the renderer is so
      // starved that the fallback wins the race (settled >= 390ms after the
      // click on the page clock with no transitionend seen), this run cannot
      // say anything about the transitionend path, so it is re-taken on a
      // fresh page. A product that settles on a timer *instead of*
      // transitionend fails on the clean attempts, and when no attempt is
      // clean the last one is asserted as-is (fails loudly, never skipped).
      const ATTEMPTS = 6;
      for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
        let retry = false;
        await withReactSkelPage({}, async (page) => {
        const sidebar = page.locator('[data-skel-shape="sidebar"]');
        expect(await sidebar.locator(".skel-content").count()).toBe(1);
        await armTransitionProbe(
          page,
          '[data-skel-shape="sidebar"] [data-skel="content"]'
        );
        await sidebar.locator('[data-skel="bars"]').evaluate((node) => {
          const target = node as HTMLElement & { __end: number };
          target.__end = 0;
          node.addEventListener("transitionend", (event) => {
            if (event.target !== node) return;
            if ((event as TransitionEvent).propertyName !== "opacity") return;
            target.__end += 1;
          });
        });
        await sidebar
          .locator('[data-testid="skeleton"]')
          .evaluate((node) => {
            const w = window as unknown as { __c?: number; __s?: number };
            document
              .querySelector('[data-testid="skel-arrive"]')
              ?.addEventListener("click", () => (w.__c = performance.now()), true);
            new MutationObserver(() => {
              if (w.__s === undefined && node.classList.contains("is-settled")) {
                w.__s = performance.now();
              }
            }).observe(node, { attributes: true, attributeFilter: ["class"] });
          });
        await page.getByTestId("skel-arrive").click();
        await page.waitForFunction(() => {
          const host = document.querySelector(
            '[data-skel-shape="sidebar"] [data-testid="skeleton"]'
          );
          return host?.classList.contains("is-settled") === true;
        });
        const barsEnd = await sidebar.locator('[data-skel="bars"]').evaluate(
          (node) => (node as HTMLElement & { __end: number }).__end
        );
        const clock = await page.evaluate(() => {
          const w = window as unknown as { __c?: number; __s?: number };
          return { click: w.__c ?? -1, settled: w.__s ?? -1 };
        });
        if (
          attempt < ATTEMPTS &&
          barsEnd === 0 &&
          clock.settled - clock.click >= 390
        ) {
          retry = true;
          return;
        }
        expect(barsEnd, "is-settled must follow bars opacity transitionend").toBe(
          1
        );
        // Past a 300ms post-arrival re-flip (M3d). Static setAttribute cases
        // never run React, so they cannot see that mutation.
        await page.waitForTimeout(400);
        const events = await readProbe(
          page,
          '[data-skel-shape="sidebar"] [data-skel="content"]'
        );
        const opacityRuns = events.filter(
          (event) => event.type === "transitionrun" && event.propertyName === "opacity"
        ).length;
        const filterRuns = events.filter(
          (event) => event.type === "transitionrun" && event.propertyName === "filter"
        ).length;
        expect(opacityRuns, `events=${JSON.stringify(events)}`).toBe(1);
        expect(filterRuns, `events=${JSON.stringify(events)}`).toBe(1);
        });
        if (!retry) return;
      }
    },
    60_000
  );

  it.skipIf(!chromiumAvailable)(
    "is-settled arrives via the 400ms fallback when transitionend never fires",
    async () => {
      await withReactSkelPage({}, async (page) => {
        const host = page.locator(
          '[data-skel-shape="sidebar"] [data-testid="skeleton"]'
        );
        // #3100: the old form slept 200ms of *test-runner* wall clock and then
        // asserted "not settled yet"; under load the sleep itself overran 400ms.
        // Timestamp both ends on the page's own clock instead: click, and the
        // frame is-settled first appears. The fallback is a 400ms timer, so
        // settle can never precede click + 400 (minus rounding) unless the
        // product shortened it or settles early some other way.
        await host.evaluate((node) => {
          const w = window as unknown as { __t?: { click: number; settled: number } };
          w.__t = { click: -1, settled: -1 };
          node.addEventListener(
            "transitionend",
            (event) => event.stopImmediatePropagation(),
            true
          );
          document
            .querySelector('[data-testid="skel-arrive"]')
            ?.addEventListener(
              "click",
              () => {
                w.__t!.click = performance.now();
              },
              true
            );
          new MutationObserver(() => {
            if (w.__t!.settled < 0 && node.classList.contains("is-settled")) {
              w.__t!.settled = performance.now();
            }
          }).observe(node, { attributes: true, attributeFilter: ["class"] });
        });
        await page.getByTestId("skel-arrive").click();
        await page.waitForFunction(
          () =>
            (window as unknown as { __t: { settled: number } }).__t.settled >= 0
        );
        const t = await page.evaluate(
          () => (window as unknown as { __t: { click: number; settled: number } }).__t
        );
        expect(t.click, "click probe must have fired").toBeGreaterThan(0);
        expect(
          t.settled - t.click,
          "must not settle before the 400ms fallback (page clock)"
        ).toBeGreaterThanOrEqual(390);
      });
    },
  );

  it.skipIf(!chromiumAvailable)(
    "Drafts empty: host height steps ≤12px, monotonic, frozen after is-settled",
    async () => {
      const samples = await traceCleanCadence("drafts", { width: 390, height: 800 });
      assertHeightLadder(samples, "drafts-empty");
    },
    60_000
  );

  it.skipIf(!chromiumAvailable)(
    "sidebar 2-channel: host height steps ≤12px, monotonic, frozen after is-settled",
    async () => {
      const samples = await traceCleanCadence("sidebar", { width: 390, height: 800 });
      assertHeightLadder(samples, "sidebar-2ch");
    },
    60_000
  );

  it.skipIf(!chromiumAvailable)(
    "sidebar 5-channel grow: host height steps ≤12px, monotonic, height transitionend fires",
    async () => {
      const samples = await traceCleanCadence("sidebar5", { width: 390, height: 800 });
      assertHeightLadder(samples, "sidebar-5ch");
    },
    60_000
  );

  it.skipIf(!chromiumAvailable)(
    "sidebar 12-channel grow: host height steps ≤12px, monotonic, height transitionend fires",
    async () => {
      const samples = await traceCleanCadence("sidebar12", { width: 390, height: 800 });
      // 224px on --motion-standard ease-out peaks ~30px/frame at 120Hz.
      // Cap 64 still fails the unanimated 224 jump; 12 would fail the ladder.
      assertHeightLadder(samples, "sidebar-12ch", 64);
    },
    60_000
  );

  it.skipIf(!chromiumAvailable)(
    "mid-flight shrink: bars visible rect is inside the host (overflow: hidden)",
    async () => {
      await withReactSkelPage(
        { viewport: { width: 390, height: 800 } },
        async (page) => {
          const drafts = page.locator('[data-skel-shape="drafts"]');
          await drafts.getByTestId("skel-arrive-drafts").click();
          await page.waitForFunction(() => {
            const host = document.querySelector(
              '[data-skel-shape="drafts"] [data-testid="skeleton"]'
            );
            return host?.classList.contains("is-sizing") === true;
          });
          // #3100: was `waitForTimeout(120)` — a wall-clock guess at "mid-flight"
          // that under load landed after the shrink ended ("must still be
          // mid-flight" false failure). Park every running height transition at
          // 50% on the page's own timeline so the state is exactly mid-flight
          // regardless of how starved the frames are.
          await drafts.locator('[data-testid="skeleton"]').evaluate((node) => {
            const running = (node as HTMLElement)
              .getAnimations()
              .filter(
                (animation) =>
                  (animation as CSSTransition).transitionProperty === "height"
              );
            if (running.length === 0) {
              throw new Error("no running height transition to park mid-flight");
            }
            for (const animation of running) {
              animation.pause();
              const duration = Number(
                animation.effect?.getComputedTiming().duration ?? 0
              );
              animation.currentTime = duration / 2;
            }
          });
          const clip = await drafts
            .locator('[data-testid="skeleton"]')
            .evaluate((node) => {
              const host = node as HTMLElement;
              const bars = host.querySelector(
                '[data-skel="bars"]'
              ) as HTMLElement | null;
              if (!bars) throw new Error("bars missing");
              const hostBox = host.getBoundingClientRect();
              const barsBox = bars.getBoundingClientRect();
              const overflow = getComputedStyle(host).overflow;
              const visible =
                overflow === "visible"
                  ? barsBox
                  : {
                      top: Math.max(barsBox.top, hostBox.top),
                      bottom: Math.min(barsBox.bottom, hostBox.bottom),
                      left: Math.max(barsBox.left, hostBox.left),
                      right: Math.min(barsBox.right, hostBox.right),
                    };
              return {
                overflow,
                sizing: host.classList.contains("is-sizing"),
                hostBottom: hostBox.bottom,
                barsBottom: barsBox.bottom,
                visibleBottom: visible.bottom,
                visibleTop: visible.top,
                hostTop: hostBox.top,
              };
            });
          expect(clip.sizing, "must still be mid-flight").toBe(true);
          expect(clip.overflow, "delete overflow:hidden → this is visible").toBe(
            "hidden"
          );
          expect(clip.visibleTop).toBeGreaterThanOrEqual(clip.hostTop - 0.5);
          expect(clip.visibleBottom).toBeLessThanOrEqual(clip.hostBottom + 0.5);
          expect(clip.barsBottom).toBeGreaterThan(clip.hostBottom + 1);
        }
      );
    },
    30_000
  );
});

