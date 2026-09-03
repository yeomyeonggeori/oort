import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";
import {
  MODAL_CONTENT_MOTION,
  MODAL_OVERLAY_MOTION,
  POPOVER_MOTION,
} from "../motion";
import { buttonVariants } from "./button";

/**
 * UX-R1a / ADR-0179 D4 — overlay enter/exit is a measured duration, not a
 * class-name presence check. jsdom does not run CSS animations; a 0s
 * getComputedStyle there would be a floor that cannot fail. Duration proofs
 * live in the Playwright probe below.
 *
 * red proof (this file):
 *   - strip MODAL_OVERLAY_MOTION from dialog overlay → open duration ≠ 200
 *   - strip POPOVER_MOTION from popover → open duration ≠ 240
 *   - drop the exit utility → close duration ≠ 150/180 and unmount dwell < 140
 *   - drop scrim-blur → backdrop-filter blur ≠ 5px
 *   - reduced-motion off → duration ≠ 0
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, "../..", "..");
const SRC = resolve(WEB_ROOT, "src");
const require_ = createRequire(import.meta.url);
const TOKENS_CSS = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");

const FILES = {
  dialog: readFileSync(new URL("./dialog.tsx", import.meta.url), "utf8"),
  popover: readFileSync(new URL("./popover.tsx", import.meta.url), "utf8"),
  dropdown: readFileSync(new URL("./dropdown-menu.tsx", import.meta.url), "utf8"),
  context: readFileSync(new URL("./context-menu.tsx", import.meta.url), "utf8"),
  select: readFileSync(new URL("./select.tsx", import.meta.url), "utf8"),
  harness: readFileSync(
    new URL("../overlayMotion.harness.tsx", import.meta.url),
    "utf8"
  ),
} as const;

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
    `UX-R1a overlay probe skipped: Playwright Chromium executable missing (${chromiumAvailability.path})`
  );
}

function classTokens(className: string): string[] {
  return className.split(/\s+/).filter(Boolean);
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

async function loadStylesheet(id: string, base: string) {
  if (id === "tailwindcss" || id.endsWith("tailwindcss/index.css")) {
    const path = require_.resolve("tailwindcss/index.css");
    return { path, base: dirname(path), content: readFileSync(path, "utf8") };
  }
  const path = id.startsWith(".") || id.startsWith("/") ? `${base}/${id}` : id;
  return { path, base: dirname(path), content: readFileSync(path, "utf8") };
}

const DESIGN = dirname(fileURLToPath(new URL("../tokens.css", import.meta.url)));

async function buildCss(candidates: string[]): Promise<string> {
  const compiler = await compile(TOKENS_CSS, { base: DESIGN, loadStylesheet });
  return compiler.build([...new Set(candidates)]);
}

export function durationMs(value: string): number {
  const first = value.split(",")[0]?.trim() ?? "";
  const n = parseFloat(first);
  if (!Number.isFinite(n)) {
    throw new Error(`animationDuration is not a number: ${JSON.stringify(value)}`);
  }
  if (first.endsWith("ms")) return n;
  if (first.endsWith("s")) return n * 1000;
  throw new Error(`animationDuration missing unit: ${JSON.stringify(value)}`);
}

function firstAnimationName(value: string): string {
  return (value.split(",")[0]?.trim() ?? "").replace(/['"]/g, "");
}

type MotionSample = {
  name: string;
  duration: number;
  pointerEvents: string;
  backdropFilter: string;
  state: string | null;
};

const OPEN = {
  dialog: { name: "motion-fade-in", ms: 200 },
  dialogZoom: { name: "motion-zoom-in", ms: 200 },
  popover: { name: "motion-fade-in", ms: 240 },
} as const;

const CLOSE = {
  dialog: { name: "motion-fade-out", ms: 150 },
  dialogZoom: { name: "motion-zoom-out", ms: 150 },
  popover: { name: "motion-fade-out", ms: 180 },
} as const;

describe("UX-R1a wiring (not the duration proof)", () => {
  it("dialog consumes the modal overlay and content constants", () => {
    expect(FILES.dialog).toContain("MODAL_OVERLAY_MOTION");
    expect(FILES.dialog).toContain("MODAL_CONTENT_MOTION");
  });

  it("popover, dropdown-menu, context-menu consume POPOVER_MOTION", () => {
    expect(FILES.popover).toContain("POPOVER_MOTION");
    expect(FILES.dropdown).toContain("POPOVER_MOTION");
    expect(FILES.context).toContain("POPOVER_MOTION");
  });

  it("select stays the native OS picker (no Radix data-state overlay)", () => {
    const code = FILES.select
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(?<!:)\/\/.*$/gm, "");
    expect(code).toMatch(/<select\b/);
    expect(code).not.toContain("POPOVER_MOTION");
    expect(code).not.toContain("data-[state=");
    expect(code).not.toContain("@radix-ui/react-select");
  });
});

/**
 * A 0s computed duration is what jsdom (and a missing stylesheet) return.
 * Treating that as the expected value is the silent-green floor this ticket
 * forbids. Callers that want 0 must pass `allowZero` (reduced-motion only).
 */
export function assertMeasuredDurationMs(
  duration: string,
  expected: number,
  allowZero = false
): number {
  const ms = durationMs(duration);
  if (!allowZero && Math.round(ms) === 0) {
    throw new Error(
      `animationDuration resolved to 0ms (${JSON.stringify(duration)}); jsdom/missing CSS cannot prove ${expected}ms. Measure in the Playwright probe.`
    );
  }
  return ms;
}

describe("jsdom/0s cannot stand in for overlay duration", () => {
  it("throws on 0s instead of counting it as 200ms", () => {
    expect(() => assertMeasuredDurationMs("0s", 200)).toThrow(/0ms/);
  });
});

describe.skipIf(!chromiumAvailable)(
  "UX-R1a overlay enter/exit (Playwright, measured ms)",
  () => {
    async function launchProbe(reducedMotion: "reduce" | "no-preference" = "no-preference") {
      const esbuild = await import("esbuild");
      const bundled = await esbuild.build({
        absWorkingDir: WEB_ROOT,
        entryPoints: [resolve(HERE, "../overlayMotion.harness.tsx")],
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        jsx: "automatic",
        alias: { "@": SRC },
        logLevel: "silent",
      });
      const js = bundled.outputFiles[0]?.text;
      if (!js) throw new Error("esbuild produced no overlayMotion harness");

      const candidates = [
        ...classTokens(MODAL_OVERLAY_MOTION),
        ...classTokens(MODAL_CONTENT_MOTION),
        ...classTokens(POPOVER_MOTION),
        ...classTokens(buttonVariants({ variant: "default" })),
        ...classTokens(buttonVariants({ variant: "secondary" })),
        ...quotedClassTokens(FILES.dialog),
        ...quotedClassTokens(FILES.popover),
        ...quotedClassTokens(FILES.dropdown),
        ...quotedClassTokens(FILES.context),
        ...quotedClassTokens(FILES.select),
        ...quotedClassTokens(FILES.harness),
        "scrim-blur",
        "bg-scrim",
        "focus-visible:focus-ring",
      ];
      const css = await buildCss(candidates);

      const { chromium } = await import("playwright");
      const browser = await chromium.launch();
      const page = await browser.newPage();
      await page.emulateMedia({ reducedMotion });
      await page.setContent(
        `<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`
      );
      await page.getByTestId("open-dialog").waitFor({ state: "visible" });
      return { browser, page };
    }

    async function sample(page: import("playwright").Page, selector: string): Promise<MotionSample> {
      return page.locator(selector).evaluate((node) => {
        const s = getComputedStyle(node);
        return {
          name: s.animationName,
          duration: s.animationDuration,
          pointerEvents: s.pointerEvents,
          backdropFilter: s.backdropFilter || s.getPropertyValue("backdrop-filter"),
          state: node.getAttribute("data-state"),
        };
      }).then((raw) => ({
        name: firstAnimationName(raw.name),
        duration: durationMs(raw.duration),
        pointerEvents: raw.pointerEvents,
        backdropFilter: raw.backdropFilter,
        state: raw.state,
      }));
    }

    async function armCloseProbe(page: import("playwright").Page, selector: string) {
      await page.evaluate((sel) => {
        const target = window as Window & {
          __closeProbe?: Promise<Record<string, string | number | boolean | null>>;
        };
        target.__closeProbe = new Promise((resolve) => {
          const started = performance.now();
          const tick = () => {
            const node = document.querySelector(sel);
            if (!node) {
              resolve({ via: "detached", missing: true, connected: false });
              return;
            }
            const s = getComputedStyle(node);
            const name = s.animationName;
            const state = node.getAttribute("data-state");
            const isExit = /fade-out|zoom-out/.test(name);
            if (state === "closed" && isExit) {
              resolve({
                via: "poll",
                state,
                name,
                duration: s.animationDuration,
                connected: node.isConnected,
              });
              return;
            }
            if (performance.now() - started > 800) {
              resolve({
                via: "timeout",
                state,
                name,
                duration: s.animationDuration,
                connected: node.isConnected,
              });
              return;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      }, selector);
    }

    async function readCloseProbe(page: import("playwright").Page) {
      const raw = await page.evaluate(() => {
        const target = window as Window & {
          __closeProbe?: Promise<Record<string, string | number | boolean | null>>;
        };
        return target.__closeProbe;
      });
      if (!raw || raw.missing) {
        return { missing: true as const, duration: 0, name: "none", via: String(raw?.via) };
      }
      return {
        missing: false as const,
        duration: durationMs(String(raw.duration)),
        name: firstAnimationName(String(raw.name)),
        via: String(raw.via),
        connected: Boolean(raw.connected),
        state: raw.state == null ? null : String(raw.state),
      };
    }

    async function unmountDwell(
      page: import("playwright").Page,
      selector: string,
      close: () => Promise<void>
    ): Promise<number> {
      const t0 = await page.evaluate(() => performance.now());
      await close();
      await page.locator(selector).waitFor({ state: "detached", timeout: 2_000 });
      return page.evaluate((start) => performance.now() - start, t0);
    }

    it("dialog overlay/content open at 200ms and close at 150ms; scrim blur is 5px", async () => {
      const { browser, page } = await launchProbe();
      try {
        await page.getByTestId("open-dialog").click();
        await page.locator('.bg-scrim[data-state="open"]').waitFor({
          state: "visible",
        });
        const overlay = await sample(page, ".bg-scrim");
        const content = await sample(page, '[data-testid="dialog-content"]');

        expect(overlay.state, `overlay state ${overlay.state}`).toBe("open");
        expect(overlay.name).toBe(OPEN.dialog.name);
        expect(Math.round(overlay.duration)).toBe(OPEN.dialog.ms);
        expect(content.name).toBe(OPEN.dialogZoom.name);
        expect(Math.round(content.duration)).toBe(OPEN.dialogZoom.ms);
        expect(overlay.backdropFilter).toMatch(/blur\(\s*5px\s*\)/);

        await armCloseProbe(page, ".bg-scrim");
        const [dwell, closed] = await Promise.all([
          unmountDwell(page, ".bg-scrim", () => page.keyboard.press("Escape")),
          readCloseProbe(page),
        ]);
        expect(closed.missing, `close probe ${closed.via}`).toBe(false);
        expect(closed.name).toBe(CLOSE.dialog.name);
        expect(Math.round(closed.duration)).toBe(CLOSE.dialog.ms);
        expect(dwell, `unmount dwell ${dwell}ms`).toBeGreaterThanOrEqual(140);
        expect(dwell).toBeLessThan(500);
      } finally {
        await browser.close();
      }
    }, 60_000);

    it("popover, dropdown-menu, context-menu open at 240ms and close at 180ms", async () => {
      const { browser, page } = await launchProbe();
      try {
        const surfaces: Array<{
          open: () => Promise<void>;
          selector: string;
        }> = [
          {
            open: () => page.getByTestId("open-popover").click(),
            selector: '[data-testid="popover-content"]',
          },
          {
            open: () => page.getByTestId("open-menu").click(),
            selector: '[data-testid="menu-content"]',
          },
          {
            open: () =>
              page.getByTestId("context-target").click({ button: "right" }),
            selector: '[data-testid="context-content"]',
          },
        ];

        for (const surface of surfaces) {
          await surface.open();
          await page.locator(`${surface.selector}[data-state="open"]`).waitFor({
            state: "visible",
          });
          const opened = await sample(page, surface.selector);
          expect(opened.name, surface.selector).toBe(OPEN.popover.name);
          expect(Math.round(opened.duration), surface.selector).toBe(OPEN.popover.ms);
          expect(opened.pointerEvents, `${surface.selector} pointer-events`).not.toBe(
            "none"
          );

          await armCloseProbe(page, surface.selector);
          const [dwell, closed] = await Promise.all([
            unmountDwell(page, surface.selector, () => page.keyboard.press("Escape")),
            readCloseProbe(page),
          ]);
          expect(closed.missing, `${surface.selector} ${closed.via}`).toBe(false);
          expect(closed.name, surface.selector).toBe(CLOSE.popover.name);
          expect(Math.round(closed.duration), surface.selector).toBe(CLOSE.popover.ms);
          expect(dwell, `${surface.selector} dwell ${dwell}`).toBeGreaterThanOrEqual(
            160
          );
          expect(dwell).toBeLessThan(500);
        }
      } finally {
        await browser.close();
      }
    }, 60_000);

    it("reduced-motion makes overlay durations 0 and unmounts immediately", async () => {
      const { browser, page } = await launchProbe("reduce");
      try {
        await page.getByTestId("open-dialog").click();
        await page.locator('.bg-scrim[data-state="open"]').waitFor({
          state: "visible",
        });
        const overlay = await sample(page, ".bg-scrim");
        expect(Math.round(overlay.duration)).toBe(0);

        const dwell = await unmountDwell(page, ".bg-scrim", () =>
          page.keyboard.press("Escape")
        );
        expect(dwell, `reduced-motion dwell ${dwell}ms`).toBeLessThan(80);
      } finally {
        await browser.close();
      }
    }, 60_000);

    it("focus ring on the first dialog frame equals the settled frame", async () => {
      const { browser, page } = await launchProbe();
      try {
        await page.getByTestId("open-dialog").focus();
        await page.keyboard.press("Enter");
        await page.locator('[data-testid="dialog-content"]').waitFor({
          state: "visible",
        });

        const readRing = () =>
          page.evaluate(() => {
            const el = document.querySelector(
              '[data-testid="dialog-action"]'
            ) as HTMLElement | null;
            const active = document.activeElement as HTMLElement | null;
            const target = el?.contains(active) ? active : el;
            if (!target) return null;
            const s = getComputedStyle(target);
            return {
              width: s.outlineWidth,
              offset: s.outlineOffset,
              color: s.outlineColor,
            };
          });

        const first = await readRing();
        await page.locator('[data-testid="dialog-content"]').evaluate((node) =>
          Promise.all(
            node.getAnimations().map((animation) => animation.finished.catch(() => undefined))
          )
        );
        const settled = await readRing();
        expect(first).not.toBeNull();
        expect(settled).toEqual(first);
      } finally {
        await browser.close();
      }
    }, 60_000);

    it("native select does not create a CSS overlay; the box duration is 0", async () => {
      const { browser, page } = await launchProbe();
      try {
        await page.getByTestId("probe-select").click();
        const listboxes = await page.locator('[role="listbox"]').count();
        const tag = await page.getByTestId("probe-select").evaluate((el) => el.tagName);
        expect(tag).toBe("SELECT");
        if (listboxes > 0) {
          const overlay = await sample(page, '[role="listbox"]');
          expect(Math.round(overlay.duration)).toBe(OPEN.popover.ms);
          throw new Error(
            `native select grew a CSS listbox (duration=${overlay.duration}); measure it as POPOVER_MOTION or keep the OS picker`
          );
        }
        const box = await sample(page, '[data-testid="probe-select"]');
        expect(Math.round(box.duration)).toBe(0);
      } finally {
        await browser.close();
      }
    }, 60_000);
  }
);
