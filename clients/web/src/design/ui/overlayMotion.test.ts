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
 * UX-R1a / ADR-0179 D4 — overlay enter/exit.
 *
 * Browser-free half (always runs): compile the motion class lists through
 * Tailwind and assert the emitted rules. A comment cannot satisfy this.
 * Closed overlay/content pointer-events must compile to `none !important`
 * so they beat Radix OverlayImpl's inline `auto` (#1997 H-1). Product
 * callers that wrap DialogContent in `{open && …}` are scanned in the same
 * file so a missing Chromium cannot hide that regression.
 *
 * Playwright half (skipIf, loud): closed-state dwell on a shipped product
 * dialog (SectionDeleteConfirmDialog), plus popover/menu durations.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, "../..", "..");
const SRC = resolve(WEB_ROOT, "src");
const CORE_SRC = resolve(WEB_ROOT, "../../packages/momo-core/src");
const HARNESS = resolve(WEB_ROOT, "measure/overlayMotion.harness.tsx");
const require_ = createRequire(import.meta.url);
const TOKENS_CSS = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");
const MOTION_CSS = readFileSync(new URL("../motion.css", import.meta.url), "utf8");

const FILES = {
  dialog: readFileSync(new URL("./dialog.tsx", import.meta.url), "utf8"),
  popover: readFileSync(new URL("./popover.tsx", import.meta.url), "utf8"),
  dropdown: readFileSync(new URL("./dropdown-menu.tsx", import.meta.url), "utf8"),
  context: readFileSync(new URL("./context-menu.tsx", import.meta.url), "utf8"),
  select: readFileSync(new URL("./select.tsx", import.meta.url), "utf8"),
  harness: readFileSync(HARNESS, "utf8"),
  createChannel: readFileSync(
    new URL("../../features/channels/CreateChannelDialog.tsx", import.meta.url),
    "utf8"
  ),
  profileCard: readFileSync(
    new URL("../../features/sidebar/ProfileCard.tsx", import.meta.url),
    "utf8"
  ),
  sectionDialogs: readFileSync(
    new URL("../../features/sidebar/SidebarSectionDialogs.tsx", import.meta.url),
    "utf8"
  ),
  channelActions: readFileSync(
    new URL("../../features/chat/channelActions.tsx", import.meta.url),
    "utf8"
  ),
  messageActions: readFileSync(
    new URL("../../features/timeline/MessageActions.tsx", import.meta.url),
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
    `UX-R1a overlay Playwright probe skipped: Playwright Chromium executable missing (${chromiumAvailability.path}). Compiled-CSS and product-mount assertions still run.`
  );
}

function classTokens(className: string): string[] {
  return className.split(/\s+/).filter(Boolean);
}

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<!:)\/\/.*$/gm, "");
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

function escapedClassSelector(candidate: string): string {
  return "." + candidate.replace(/[:[\]=.!]/g, (ch) => "\\" + ch);
}

function ruleFor(css: string, token: string): string {
  const selector = escapedClassSelector(token);
  const from = css.indexOf(selector);
  if (from < 0) return "";
  const to = css.indexOf("}", from);
  return to < 0 ? css.slice(from) : css.slice(from, to + 1);
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

const PRODUCT_DIALOG_SITES = [
  {
    name: "CreateChannelDialog",
    source: FILES.createChannel,
    forbidden: /\{\s*open\s*&&\s*\(\s*<CreateChannelPanel/,
  },
  {
    name: "ProfileCard logout confirm",
    source: FILES.profileCard,
    forbidden: /\{\s*confirmLogout\s*&&\s*\(\s*<DialogContent/,
  },
  {
    name: "SidebarSectionDialogs",
    source: FILES.sectionDialogs,
    forbidden: /\{\s*open\s*&&\s*\(\s*<DialogContent/,
  },
  {
    name: "ChannelLeaveConfirmDialog",
    source: FILES.channelActions,
    forbidden: /\{\s*leave\.confirmOpen\s*&&\s*\(\s*<DialogContent/,
  },
] as const;

describe("UX-R1a compiled CSS (browser-free)", () => {
  it("MODAL_OVERLAY_MOTION emits modal-enter/exit against the 200/150 tokens", async () => {
    const tokens = classTokens(MODAL_OVERLAY_MOTION);
    const css = await buildCss(tokens);
    expect(MOTION_CSS).toMatch(/--motion-modal-open:\s*200ms/);
    expect(MOTION_CSS).toMatch(/--motion-modal-close:\s*150ms/);
    expect(css).toMatch(/var\(--motion-modal-open\)/);
    expect(css).toMatch(/var\(--motion-modal-close\)/);
    for (const token of tokens) {
      expect(css.includes(escapedClassSelector(token)), token).toBe(true);
    }
  });

  it("MODAL_CONTENT_MOTION emits zoom enter/exit and closed pointer-events-none", async () => {
    const tokens = classTokens(MODAL_CONTENT_MOTION);
    const css = await buildCss(tokens);
    expect(css).toMatch(/var\(--motion-modal-open\)/);
    expect(css).toMatch(/var\(--motion-modal-close\)/);
    expect(tokens).toContain("data-[state=closed]:pointer-events-none!");
    for (const token of tokens) {
      expect(css.includes(escapedClassSelector(token)), token).toBe(true);
    }
  });

  it("closed overlay/content pointer-events is none !important (beats Radix inline auto)", async () => {
    const closed = "data-[state=closed]:pointer-events-none!";
    for (const [name, className] of [
      ["MODAL_OVERLAY_MOTION", MODAL_OVERLAY_MOTION],
      ["MODAL_CONTENT_MOTION", MODAL_CONTENT_MOTION],
    ] as const) {
      const tokens = classTokens(className);
      expect(tokens, name).toContain(closed);
      const css = await buildCss(tokens);
      const rule = ruleFor(css, closed);
      expect(rule, `${name} emitted closed rule`).not.toBe("");
      expect(rule, name).toMatch(/pointer-events\s*:\s*none\s*!important/);
    }
  });

  it("POPOVER_MOTION emits standard open / fast close", async () => {
    const tokens = classTokens(POPOVER_MOTION);
    const css = await buildCss(tokens);
    expect(MOTION_CSS).toMatch(/--motion-standard:\s*240ms/);
    expect(MOTION_CSS).toMatch(/--motion-fast:\s*180ms/);
    expect(css).toMatch(/var\(--motion-standard\)/);
    expect(css).toMatch(/var\(--motion-fast\)/);
    for (const token of tokens) {
      expect(css.includes(escapedClassSelector(token)), token).toBe(true);
    }
  });

  it("scrim-blur emits blur(5px)", async () => {
    const css = await buildCss(["scrim-blur"]);
    expect(css.includes(escapedClassSelector("scrim-blur"))).toBe(true);
    expect(css).toMatch(/blur\(\s*5px\s*\)/);
  });
});

describe("UX-R1a primitive wiring (comment-stripped)", () => {
  it("dialog consumes the modal overlay and content constants as identifiers", () => {
    const code = codeOnly(FILES.dialog);
    expect(code).toMatch(/\bMODAL_OVERLAY_MOTION\b/);
    expect(code).toMatch(/\bMODAL_CONTENT_MOTION\b/);
    // #1997 H-1: closed pe=none is the `!` class, not an inline assignment.
    expect(code).not.toMatch(/\bpointerEvents\b/);
    expect(code).not.toMatch(/DialogOpenContext/);
    expect(code).not.toMatch(/design-preflight-allow/);
  });

  it("popover, dropdown-menu, context-menu import and pass POPOVER_MOTION", () => {
    for (const [name, source] of [
      ["popover", FILES.popover],
      ["dropdown-menu", FILES.dropdown],
      ["context-menu", FILES.context],
    ] as const) {
      const code = codeOnly(source);
      expect(code, name).toMatch(/import\s*\{[\s\S]*\bPOPOVER_MOTION\b/);
      expect(code, name).toMatch(/\bPOPOVER_MOTION\s*[,)]/);
    }
  });

  it("select stays the native OS picker (no Radix data-state overlay)", () => {
    const code = codeOnly(FILES.select);
    expect(code).toMatch(/<select\b/);
    expect(code).not.toContain("POPOVER_MOTION");
    expect(code).not.toContain("data-[state=");
    expect(code).not.toContain("@radix-ui/react-select");
  });

  it("touch action sheet overrides modal origin-center with origin-bottom", () => {
    const code = codeOnly(FILES.messageActions);
    expect(code).toMatch(
      /data-testid=["']message-action-sheet["'][\s\S]{0,400}origin-bottom/
    );
  });
});

describe("UX-R1a product dialogs stay mounted through close", () => {
  it.each(PRODUCT_DIALOG_SITES)(
    "$name does not unmount DialogContent with {open &&}",
    ({ source, forbidden }) => {
      expect(codeOnly(source)).not.toMatch(forbidden);
    }
  );
});

describe.skipIf(!chromiumAvailable)(
  "UX-R1a overlay enter/exit (Playwright, measured ms)",
  () => {
    async function launchProbe(reducedMotion: "reduce" | "no-preference" = "no-preference") {
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
        ...quotedClassTokens(FILES.sectionDialogs),
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

    it("product dialog (SectionDeleteConfirmDialog) overlay opens at 200ms and close dwell is ≥140ms", async () => {
      const { browser, page } = await launchProbe();
      try {
        await page.getByTestId("open-dialog").click();
        await page.locator('[data-testid="sidebar-section-delete-confirm"][data-state="open"]').waitFor({
          state: "visible",
        });
        const overlay = await sample(page, ".bg-scrim");
        const content = await sample(page, '[data-testid="sidebar-section-delete-confirm"]');

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
        expect(dwell, `product dialog unmount dwell ${dwell}ms`).toBeGreaterThanOrEqual(140);
        expect(dwell).toBeLessThan(500);
      } finally {
        await browser.close();
      }
    }, 60_000);

    async function behindPoint(page: import("playwright").Page) {
      const box = await page.getByTestId("click-behind").boundingBox();
      if (!box) throw new Error("click-behind missing");
      return { x: box.x + Math.min(8, box.width / 2), y: box.y + Math.min(8, box.height / 2) };
    }

    async function behindClicks(page: import("playwright").Page): Promise<number> {
      return page.getByTestId("click-behind").evaluate((el) =>
        Number(el.getAttribute("data-clicks") ?? "0")
      );
    }

    it("Escape then click-behind at 30/60/120ms lands; open overlay still blocks", async () => {
      const { browser, page } = await launchProbe();
      const overlaySelector = ".bg-scrim";
      try {
        const open = async () => {
          await page.getByTestId("open-dialog").click();
          await page
            .locator('[data-testid="sidebar-section-delete-confirm"][data-state="open"]')
            .waitFor({ state: "visible" });
        };
        await open();
        const { x, y } = await behindPoint(page);
        const blockedBefore = await behindClicks(page);
        await page.mouse.click(x, y);
        expect(
          await behindClicks(page),
          "open overlay must block the control behind"
        ).toBe(blockedBefore);

        for (const delay of [30, 60, 120]) {
          const lingering = page.locator(overlaySelector).first();
          if ((await lingering.count()) > 0) {
            if ((await lingering.getAttribute("data-state")) === "open") {
              await page.keyboard.press("Escape");
            }
            await lingering.waitFor({ state: "detached", timeout: 2_000 });
          }
          await open();
          await page.keyboard.press("Escape");
          await page.evaluate((ms) => new Promise((resolve) => setTimeout(resolve, ms)), delay);
          const overlay = page.locator(overlaySelector).first();
          expect(
            await overlay.count(),
            `t+${delay}ms overlay still attached`
          ).toBeGreaterThan(0);
          expect(await overlay.getAttribute("data-state")).toBe("closed");
          expect(
            await overlay.evaluate((el) => getComputedStyle(el).pointerEvents),
            `t+${delay}ms overlay pointer-events`
          ).toBe("none");
          const before = await behindClicks(page);
          await page.mouse.click(x, y);
          expect(
            await behindClicks(page),
            `t+${delay}ms click behind ${overlaySelector}`
          ).toBe(before + 1);
        }
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
