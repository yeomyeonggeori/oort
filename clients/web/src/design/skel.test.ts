import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";

/**
 * UX-R1c / ADR-0179 D3 — skeleton → content blur crossfade.
 *
 * Each case isolates one number. Chromium missing → throw (never skip).
 *
 * red proof:
 *   - drop @utility skel → compile selector test is red
 *   - stack layers (no grid-area) → wrapper height equals the sum, not one layer
 *   - skip the ready transition → opacity transitionrun count is 0, not 1
 *   - drop is-resetting { transition: none } → remount count is not 0
 *   - drop reduced-motion { transition: none } → reduce count is not 0
 *   - leave pulse running after ready → animation-play-state stays running
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const TOKENS_CSS = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

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

function requireChromium(): typeof import("playwright").chromium {
  const availability = detectChromium();
  if (!availability.ok) {
    throw new Error(
      `skel runtime proofs need Playwright Chromium (no skip): ${availability.path}`
    );
  }
  return (require_("playwright") as typeof import("playwright")).chromium;
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
  "p-2",
  "h-6",
  "rounded-sm",
  "bg-surface-hover",
];

function skelFixtureHtml(contentRows = 4): string {
  const bars = Array.from(
    { length: 4 },
    () =>
      `<div class="h-6 rounded-sm bg-surface-hover" data-testid="skeleton-row"></div>`
  ).join("");
  const lines = Array.from(
    { length: contentRows },
    (_, i) =>
      `<div class="h-6">alpha standup notes line ${i + 1}</div>`
  ).join("");
  return `<div id="host" class="skel" data-testid="skeleton" data-ready="false">
  <div class="skel-layer skel-bars flex flex-col gap-2 p-2" data-skel="bars" aria-hidden="true">${bars}</div>
  <div class="skel-layer skel-content" data-skel="content">
    <div class="flex flex-col gap-2 p-2">${lines}</div>
  </div>
</div>`;
}

async function withSkelPage(
  options: {
    reducedMotion?: "reduce" | "no-preference";
    contentRows?: number;
  },
  run: (page: import("playwright").Page) => Promise<void>
): Promise<void> {
  const chromium = requireChromium();
  const css = await buildCss(SKEL_CANDIDATES);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      reducedMotion: options.reducedMotion ?? "no-preference",
    });
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head><body>${skelFixtureHtml(options.contentRows ?? 4)}</body></html>`
    );
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
  await page.locator("#host").evaluate((node, next) => {
    node.setAttribute("data-ready", next ? "true" : "false");
  }, ready);
}

describe("UX-R1c @utility skel CSS", () => {
  it("tokens.css declares @utility skel", () => {
    expect(TOKENS_CSS).toMatch(/@utility skel\b/);
  });

  it("compiled .skel is a grid (one cell, not a column stack)", async () => {
    const css = await buildCss(["skel"]);
    expect(css).toMatch(/\.skel\s*\{[^}]*display:\s*grid/);
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
});

describe("UX-R1c runtime — one number per case", () => {
  it(
    "ready false→true: content opacity transitionrun count is 1",
    async () => {
      await withSkelPage({}, async (page) => {
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

  it(
    "ready false→true: content filter transitionrun count is 1",
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

  it(
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

  it(
    "overlay: wrapper height equals one layer, not the sum",
    async () => {
      await withSkelPage({}, async (page) => {
        const box = await page.locator("#host").evaluate((node) => {
          const host = node as HTMLElement;
          const bars = host.querySelector('[data-skel="bars"]') as HTMLElement;
          const content = host.querySelector(
            '[data-skel="content"]'
          ) as HTMLElement;
          return {
            host: host.getBoundingClientRect().height,
            bars: bars.getBoundingClientRect().height,
            content: content.getBoundingClientRect().height,
          };
        });
        expect(box.bars).toBeGreaterThan(0);
        expect(box.content).toBe(box.bars);
        expect(box.host).toBe(box.bars);
        expect(box.host).not.toBe(box.bars + box.content);
      });
    },
    20_000
  );

  it(
    "layout shift: wrapper height stays the taller layer (not the sum) after ready",
    async () => {
      await withSkelPage({ contentRows: 8 }, async (page) => {
        const measure = () =>
          page.locator("#host").evaluate((node) => {
            const host = node as HTMLElement;
            const content = host.querySelector(
              '[data-skel="content"]'
            ) as HTMLElement;
            return {
              host: host.getBoundingClientRect().height,
              content: content.getBoundingClientRect().height,
            };
          });
        const before = await measure();
        expect(before.host).toBe(before.content);
        await setReady(page, true);
        await page.waitForTimeout(400);
        const after = await measure();
        expect(after.host).toBe(before.host);
      });
    },
    20_000
  );

  it(
    "is-resetting: content transitionrun count is 0",
    async () => {
      await withSkelPage({}, async (page) => {
        await page.locator("#host").evaluate((node) => {
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

  it(
    "reduced-motion: content transitionrun count is 0",
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

  it(
    "reduced-motion: pulse animation-name is none",
    async () => {
      await withSkelPage({ reducedMotion: "reduce" }, async (page) => {
        const pulse = await page.locator('[data-skel="bars"]').evaluate((node) => {
          const style = getComputedStyle(node as HTMLElement);
          return style.animationName;
        });
        expect(pulse).toBe("none");
      });
    },
    20_000
  );

  it(
    "pulse is running while !ready",
    async () => {
      await withSkelPage({}, async (page) => {
        const pulse = await page.locator('[data-skel="bars"]').evaluate((node) => {
          const style = getComputedStyle(node as HTMLElement);
          return {
            name: style.animationName,
            playState: style.animationPlayState,
          };
        });
        expect(pulse.name).not.toBe("none");
        expect(pulse.playState).toBe("running");
      });
    },
    20_000
  );

  it(
    "pulse animation-play-state is paused when ready",
    async () => {
      await withSkelPage({}, async (page) => {
        await setReady(page, true);
        const pulse = await page.locator('[data-skel="bars"]').evaluate((node) => {
          const style = getComputedStyle(node as HTMLElement);
          return {
            name: style.animationName,
            playState: style.animationPlayState,
          };
        });
        expect(pulse.name, "paused pulse must still be named").not.toBe("none");
        expect(pulse.playState).toBe("paused");
      });
    },
    20_000
  );
});
