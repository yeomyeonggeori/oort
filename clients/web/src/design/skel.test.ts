import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";
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

async function buildCss(candidates: string[]): Promise<string> {
  const compiler = await compile(TOKENS_CSS, { base: HERE, loadStylesheet });
  return compiler.build(candidates);
}

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
  const { chromium } = await import("playwright");
  const css = await buildCss(SKEL_CANDIDATES);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      reducedMotion: options.reducedMotion ?? "no-preference",
    });
    const markup = productMarkup(options.ready ?? false, options.site ?? "sidebar");
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head><body>${markup}</body></html>`
    );
    await run(page);
  } finally {
    await browser.close();
  }
}

async function withReactSkelPage(
  options: { reducedMotion?: "reduce" | "no-preference" },
  run: (page: import("playwright").Page) => Promise<void>
): Promise<void> {
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
  const css = await buildCss(SKEL_CANDIDATES);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      reducedMotion: options.reducedMotion ?? "no-preference",
    });
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`
    );
    await page.getByTestId("skel-arrive").waitFor({ state: "visible" });
    await run(page);
  } finally {
    await browser.close();
  }
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
});

describe("UX-R1c product binding — real Skeleton markup", () => {
  it("States.tsx paints skel-content and skel-bars (rename turns this red)", () => {
    expect(STATES_SRC).toMatch(/className=\{cn\(\s*"skel-layer skel-bars/);
    expect(STATES_SRC).toMatch(/className="skel-layer skel-content"/);
    expect(STATES_SRC).toMatch(/className="h-6 rounded-sm bg-surface-hover"/);
  });

  it("Drafts and Activity wrap empty states (not a literal prop spelling)", () => {
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
        await page.waitForTimeout(400);
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
        await page.waitForTimeout(400);
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
        await page.waitForTimeout(400);
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
        await page.waitForTimeout(400);
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
      await withReactSkelPage({}, async (page) => {
        expect(await page.locator(".skel-content").count()).toBe(1);
        await armTransitionProbe(page, '[data-skel="content"]');
        await page.locator('[data-skel="bars"]').evaluate((node) => {
          const target = node as HTMLElement & { __end: number };
          target.__end = 0;
          node.addEventListener("transitionend", (event) => {
            if (event.target !== node) return;
            if ((event as TransitionEvent).propertyName !== "opacity") return;
            target.__end += 1;
          });
        });
        await page.getByTestId("skel-arrive").click();
        await page.waitForFunction(() => {
          const host = document.querySelector('[data-testid="skeleton"]');
          return host?.classList.contains("is-settled") === true;
        });
        const barsEnd = await page.locator('[data-skel="bars"]').evaluate(
          (node) => (node as HTMLElement & { __end: number }).__end
        );
        expect(barsEnd, "is-settled must follow bars opacity transitionend").toBe(
          1
        );
        // Past a 300ms post-arrival re-flip (M3d). Static setAttribute cases
        // never run React, so they cannot see that mutation.
        await page.waitForTimeout(400);
        const events = await readProbe(page, '[data-skel="content"]');
        const opacityRuns = events.filter(
          (event) => event.type === "transitionrun" && event.propertyName === "opacity"
        ).length;
        const filterRuns = events.filter(
          (event) => event.type === "transitionrun" && event.propertyName === "filter"
        ).length;
        expect(opacityRuns, `events=${JSON.stringify(events)}`).toBe(1);
        expect(filterRuns, `events=${JSON.stringify(events)}`).toBe(1);
      });
    },
    30_000
  );

  it.skipIf(!chromiumAvailable)(
    "is-settled arrives via the 400ms fallback when transitionend never fires",
    async () => {
      await withReactSkelPage({}, async (page) => {
        await page.locator('[data-skel="bars"]').evaluate((node) => {
          node.addEventListener(
            "transitionend",
            (event) => event.stopImmediatePropagation(),
            true
          );
        });
        await page.getByTestId("skel-arrive").click();
        await page.waitForTimeout(200);
        const early = await page
          .locator('[data-testid="skeleton"]')
          .evaluate((node) => node.classList.contains("is-settled"));
        expect(early, "must not settle before the 400ms fallback").toBe(false);
        await page.waitForFunction(() => {
          const host = document.querySelector('[data-testid="skeleton"]');
          return host?.classList.contains("is-settled") === true;
        });
      });
    },
    30_000
  );
});

