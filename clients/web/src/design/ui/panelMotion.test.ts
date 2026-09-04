import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";
import {
  DRAWER_SCRIM_MOTION,
  MODAL_CONTENT_MOTION,
  MODAL_OVERLAY_MOTION,
  PALETTE_ITEM_MOTION,
  PANEL_MOTION,
} from "../motion";
import { buttonVariants } from "./button";

/**
 * UX-R1b / ADR-0179 D1·D4·D8 — drawer, thread panel, ⌘K enter/exit.
 *
 * Browser-free half (always runs): compiled CSS, product-site wiring,
 * AnimatePresence / useReducedMotion / no `layout` on palette items.
 *
 * Playwright half (skipIf, loud): measured ms on the shipped components
 * (QuickSwitcher, ThreadPanel, SidebarDrawerScrim + `.sidebar-drawer`),
 * both schemes, exit closed-frames > 0, reduced-motion duration 0.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, "../..", "..");
const SRC = resolve(WEB_ROOT, "src");
const CORE_SRC = resolve(WEB_ROOT, "../../packages/momo-core/src");
const HARNESS = resolve(WEB_ROOT, "measure/panelMotion.harness.tsx");
const require_ = createRequire(import.meta.url);
const TOKENS_CSS = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");
const MOTION_CSS = readFileSync(new URL("../motion.css", import.meta.url), "utf8");

const FILES = {
  motionTs: readFileSync(new URL("../motion.ts", import.meta.url), "utf8"),
  quickSwitcher: readFileSync(
    new URL("../../app/QuickSwitcher.tsx", import.meta.url),
    "utf8"
  ),
  threadPanel: readFileSync(
    new URL("../../features/timeline/ThreadPanel.tsx", import.meta.url),
    "utf8"
  ),
  sidebar: readFileSync(
    new URL("../../features/sidebar/Sidebar.tsx", import.meta.url),
    "utf8"
  ),
  appShell: readFileSync(new URL("../../app/AppShell.tsx", import.meta.url), "utf8"),
  chatShell: readFileSync(
    new URL("../../features/chat/ChatShell.tsx", import.meta.url),
    "utf8"
  ),
  harness: readFileSync(HARNESS, "utf8"),
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
    `UX-R1b panel Playwright probe skipped: Playwright Chromium executable missing (${chromiumAvailability.path}). Compiled-CSS and product-mount assertions still run.`
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
  return "." + candidate.replace(/[:[\]=.]/g, (ch) => "\\" + ch);
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
  if (first === "" || first === "none") return 0;
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

const MOTION_LIB_ALLOWLIST = [
  "src/app/QuickSwitcher.tsx",
  "src/features/timeline/ThreadPanel.tsx",
  "src/features/sidebar/Sidebar.tsx",
] as const;

describe("UX-R1b compiled CSS (browser-free)", () => {
  it("DRAWER_SCRIM_MOTION emits fast enter/exit against --motion-fast", async () => {
    const tokens = classTokens(DRAWER_SCRIM_MOTION);
    const css = await buildCss(tokens);
    expect(MOTION_CSS).toMatch(
      /@utility motion-fast-enter\s*\{[\s\S]*?motion-fade-in\s+var\(--motion-fast\)/
    );
    expect(MOTION_CSS).toMatch(
      /@utility motion-fast-exit\s*\{[\s\S]*?motion-fade-out\s+var\(--motion-fast\)/
    );
    expect(css).toMatch(/var\(--motion-fast\)/);
    for (const token of tokens) {
      expect(css.includes(escapedClassSelector(token)), token).toBe(true);
    }
  });

  it("PANEL_MOTION emits standard slide-in and fast slide-out", async () => {
    const tokens = classTokens(PANEL_MOTION);
    const css = await buildCss(tokens);
    expect(MOTION_CSS).toMatch(/--motion-standard:\s*240ms/);
    expect(css).toMatch(/var\(--motion-standard\)/);
    expect(css).toMatch(/var\(--motion-fast\)/);
    expect(css).toMatch(/translateX\(\s*100%\s*\)/);
    for (const token of tokens) {
      expect(css.includes(escapedClassSelector(token)), token).toBe(true);
    }
  });

  it("PALETTE_ITEM_MOTION is fade-only (no layout utility)", async () => {
    const tokens = classTokens(PALETTE_ITEM_MOTION);
    const css = await buildCss(tokens);
    expect(css).toMatch(/var\(--motion-fast\)/);
    expect(PALETTE_ITEM_MOTION).not.toMatch(/\blayout\b/);
    for (const token of tokens) {
      expect(css.includes(escapedClassSelector(token)), token).toBe(true);
    }
  });

  it("390 drawer CSS uses --motion-fast both ways (tokens.css)", () => {
    const block = TOKENS_CSS.slice(TOKENS_CSS.indexOf("@utility sidebar-drawer"));
    const mobile = block.slice(0, block.indexOf("@utility sidebar-scrim"));
    expect(mobile).toMatch(
      /transition:\s*transform\s+var\(--motion-fast\)\s+var\(--motion-ease-standard\)/
    );
    expect(mobile).not.toMatch(
      /transition:\s*transform\s+var\(--motion-standard\)/
    );
  });

  it("desktop sidebar collapse uses --duration-sidebar = --motion-standard", () => {
    expect(TOKENS_CSS).toMatch(/--duration-sidebar:\s*var\(--motion-standard\);/);
    expect(TOKENS_CSS).toMatch(
      /transition:\s*grid-template-columns\s+var\(--duration-sidebar\)/
    );
  });
});

describe("UX-R1b product wiring (comment-stripped)", () => {
  it("the three allowlisted files import from motion/react", () => {
    for (const [name, source] of [
      ["QuickSwitcher", FILES.quickSwitcher],
      ["ThreadPanel", FILES.threadPanel],
      ["Sidebar", FILES.sidebar],
    ] as const) {
      const code = codeOnly(source);
      expect(code, name).toMatch(/from\s+["']motion\/react["']/);
      expect(code, name).toMatch(/\bAnimatePresence\b/);
      expect(code, name).toMatch(/\buseReducedMotion\b/);
      expect(code, name).toMatch(/\busePresence\b/);
    }
  });

  it("motion.ts does not import motion/react (constants only)", () => {
    expect(codeOnly(FILES.motionTs)).not.toMatch(/from\s+["']motion\/react["']/);
  });

  it("allowlist is exactly the three product files", () => {
    expect([...MOTION_LIB_ALLOWLIST].sort()).toEqual(
      [
        "src/app/QuickSwitcher.tsx",
        "src/features/sidebar/Sidebar.tsx",
        "src/features/timeline/ThreadPanel.tsx",
      ].sort()
    );
  });

  it("⌘K consumes MODAL_* constants and AnimatePresence; list items have no layout prop", () => {
    const code = codeOnly(FILES.quickSwitcher);
    expect(code).toMatch(/\bMODAL_CONTENT_MOTION\b/);
    expect(code).toMatch(/\bPALETTE_ITEM_MOTION\b/);
    expect(code).toMatch(/<AnimatePresence>/);
    expect(code).not.toMatch(/\blayout=/);
    expect(code).not.toMatch(/\blayout:/);
    expect(code).not.toMatch(/Command\.Dialog/);
  });

  it("ThreadPanel keeps playEntrance wiring and delays onClose until exit", () => {
    const code = codeOnly(FILES.threadPanel);
    expect(code).toMatch(/\bPANEL_MOTION\b/);
    expect(code).toContain("playEntrance={isPlayEntrance?.(root.id) ?? false}");
    expect(code).toContain("playEntrance={isPlayEntrance?.(reply.id) ?? false}");
    expect(code).toMatch(/setLeaving\(true\)/);
    expect(code).toMatch(/onExitComplete=\{finishClose\}/);
  });

  it("ChatShell still binds arrival props on ThreadPanel (R1d)", () => {
    const code = codeOnly(FILES.chatShell);
    expect(code).toMatch(/\bisPlayEntrance=\{timeline\.isPlayEntrance\}/);
    expect(code).toMatch(/\bonEntranceConsumed=\{timeline\.consumeEntrance\}/);
  });

  it("AppShell no longer unmounts the 390 scrim with {drawerOpen &&}", () => {
    const shell = codeOnly(FILES.appShell);
    expect(shell).not.toMatch(/drawerOpen\s*&&[\s\S]{0,80}sidebar-scrim/);
    expect(codeOnly(FILES.sidebar)).toMatch(/\bSidebarDrawerScrimLayer\b/);
    expect(codeOnly(FILES.sidebar)).toMatch(/\bDRAWER_SCRIM_MOTION\b/);
  });

  it("the measure harness does not import motion/react (allowlist stays three)", () => {
    expect(codeOnly(FILES.harness)).not.toMatch(/from\s+["']motion\/react["']/);
  });
});

describe.skipIf(!chromiumAvailable)(
  "UX-R1b drawer/panel/palette (Playwright, measured ms)",
  () => {
    async function launchProbe(
      reducedMotion: "reduce" | "no-preference" = "no-preference",
      colorScheme: "light" | "dark" = "light"
    ) {
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
            "https://example.test/panel-motion-harness.js"
          ),
        },
        logLevel: "silent",
      });
      const js = bundled.outputFiles[0]?.text;
      if (!js) throw new Error("esbuild produced no panelMotion harness");

      const candidates = [
        ...classTokens(MODAL_OVERLAY_MOTION),
        ...classTokens(MODAL_CONTENT_MOTION),
        ...classTokens(DRAWER_SCRIM_MOTION),
        ...classTokens(PANEL_MOTION),
        ...classTokens(PALETTE_ITEM_MOTION),
        ...classTokens(buttonVariants({ variant: "default" })),
        ...quotedClassTokens(FILES.quickSwitcher),
        ...quotedClassTokens(FILES.threadPanel),
        ...quotedClassTokens(FILES.sidebar),
        ...quotedClassTokens(FILES.harness),
        "sidebar-drawer",
        "sidebar-scrim",
        "scrim-blur",
        "app-shell",
        "thread-pane",
        "bg-scrim",
        "shadow-lg",
        "focus-visible:focus-ring",
      ];
      const css = await buildCss(candidates);

      const { chromium } = await import("playwright");
      const browser = await chromium.launch();
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (err) => {
        pageErrors.push(err instanceof Error ? err.message : String(err));
      });
      await page.emulateMedia({ reducedMotion, colorScheme });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.setContent(
        `<!doctype html><html><head><style>${css}</style></head><body>
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
})();
</script>
<script>${js}</script>
</body></html>`
      );
      if (pageErrors.length > 0) {
        await browser.close();
        throw new Error(`panelMotion harness pageerror: ${pageErrors.join("; ")}`);
      }
      try {
        await page.getByTestId("open-drawer").waitFor({ state: "visible", timeout: 10_000 });
      } catch (err) {
        await browser.close();
        const extra = pageErrors.length > 0 ? ` pageerror=${pageErrors.join("; ")}` : "";
        throw new Error(
          `open-drawer not visible.${extra} ${err instanceof Error ? err.message : String(err)}`
        );
      }
      return { browser, page };
    }

    async function sample(
      page: import("playwright").Page,
      selector: string
    ): Promise<{
      name: string;
      duration: number;
      transitionDuration: number;
      state: string | null;
      backdropFilter: string;
    }> {
      const raw = await page.locator(selector).evaluate((node) => {
        const s = getComputedStyle(node);
        return {
          name: s.animationName,
          duration: s.animationDuration,
          transitionDuration: s.transitionDuration,
          state: node.getAttribute("data-state"),
          backdropFilter: s.backdropFilter || s.getPropertyValue("backdrop-filter"),
        };
      });
      return {
        name: firstAnimationName(raw.name),
        duration: durationMs(raw.duration === "none" ? "0ms" : raw.duration),
        transitionDuration: durationMs(
          raw.transitionDuration === "none" || raw.transitionDuration === ""
            ? "0ms"
            : raw.transitionDuration
        ),
        state: raw.state,
        backdropFilter: raw.backdropFilter,
      };
    }

    async function closeTrace(
      page: import("playwright").Page,
      selector: string,
      close: () => Promise<void>
    ): Promise<{ frames: number; dwell: number }> {
      await page.evaluate((sel) => {
        const target = window as Window & {
          __exitTrace?: Promise<{ frames: number; dwell: number }>;
        };
        target.__exitTrace = new Promise((resolve) => {
          const started = performance.now();
          let frames = 0;
          const tick = () => {
            const node = document.querySelector(sel);
            if (!node) {
              resolve({ frames, dwell: performance.now() - started });
              return;
            }
            if (node.getAttribute("data-state") === "closed") frames += 1;
            if (performance.now() - started > 800) {
              resolve({ frames, dwell: performance.now() - started });
              return;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      }, selector);
      await close();
      const raw = await page.evaluate(() => {
        const target = window as Window & {
          __exitTrace?: Promise<{ frames: number; dwell: number }>;
        };
        return target.__exitTrace;
      });
      return raw ?? { frames: 0, dwell: 0 };
    }

    for (const scheme of ["light", "dark"] as const) {
      it(`${scheme}: 390 drawer enter/exit are --motion-fast and scrim exit plays`, async () => {
        const { browser, page } = await launchProbe("no-preference", scheme);
        try {
          await page.getByTestId("open-drawer").click();
          await page.locator('[data-testid="sidebar-scrim"][data-state="open"]').waitFor({
            state: "visible",
          });
          const drawer = await sample(page, "[data-testid='sidebar']");
          const scrim = await sample(page, "[data-testid='sidebar-scrim']");
          expect(drawer.state).toBe("open");
          expect(Math.round(drawer.transitionDuration)).toBe(180);
          expect(scrim.name).toBe("motion-fade-in");
          expect(Math.round(scrim.duration)).toBe(180);
          expect(scrim.backdropFilter).toMatch(/blur\(\s*5px\s*\)/);

          const trace = await closeTrace(page, "[data-testid='sidebar-scrim']", () =>
            page.getByTestId("sidebar-scrim").dispatchEvent("click")
          );
          expect(trace.frames, `${scheme} scrim closed frames ${trace.frames}`).toBeGreaterThan(
            0
          );
          expect(trace.dwell, `${scheme} scrim dwell ${trace.dwell}`).toBeGreaterThanOrEqual(
            140
          );
          await page.locator("[data-testid='sidebar-scrim']").waitFor({
            state: "detached",
            timeout: 2_000,
          });
        } finally {
          await browser.close();
        }
      }, 60_000);

      it(`${scheme}: thread panel opens at 240ms and close exit plays`, async () => {
        const { browser, page } = await launchProbe("no-preference", scheme);
        try {
          await page.getByTestId("open-thread").click();
          await page.locator('[data-testid="thread-panel"][data-state="open"]').waitFor({
            state: "attached",
          });
          const opened = await sample(page, "[data-testid='thread-panel']");
          expect(opened.name).toBe("motion-slide-in-end");
          expect(Math.round(opened.duration)).toBe(240);

          const [trace] = await Promise.all([
            closeTrace(page, "[data-testid='thread-panel']", () =>
              page.getByTestId("thread-close").click()
            ),
          ]);
          expect(trace.frames, `${scheme} panel closed frames`).toBeGreaterThan(0);
          expect(trace.dwell).toBeGreaterThanOrEqual(140);
          await page.locator("[data-testid='thread-panel']").waitFor({
            state: "detached",
            timeout: 2_000,
          });
        } finally {
          await browser.close();
        }
      }, 60_000);

      it(`${scheme}: ⌘K palette opens at 200ms and AnimatePresence holds the exit`, async () => {
        const { browser, page } = await launchProbe("no-preference", scheme);
        try {
          await page.getByTestId("open-palette").click();
          await page.locator("[data-testid='quick-switcher']").waitFor({
            state: "visible",
          });
          const overlay = await sample(page, "[data-testid='quick-switcher-overlay']");
          const content = await sample(page, "[data-testid='quick-switcher']");
          expect(overlay.name).toBe("motion-fade-in");
          expect(Math.round(overlay.duration)).toBe(200);
          expect(content.name).toBe("motion-zoom-in");
          expect(Math.round(content.duration)).toBe(200);

          const trace = await closeTrace(
            page,
            "[data-testid='quick-switcher-overlay']",
            () => page.keyboard.press("Escape")
          );
          expect(trace.frames, `${scheme} palette closed frames`).toBeGreaterThan(0);
          expect(trace.dwell).toBeGreaterThanOrEqual(120);
          await page.locator("[data-testid='quick-switcher']").waitFor({
            state: "detached",
            timeout: 2_000,
          });
        } finally {
          await browser.close();
        }
      }, 60_000);
    }

    it("desktop sidebar collapse is --motion-standard (240ms)", async () => {
      const { browser, page } = await launchProbe("no-preference", "light");
      try {
        await page.setViewportSize({ width: 1280, height: 800 });
        const rest = await sample(page, "[data-testid='drawer-shell']");
        expect(Math.round(rest.transitionDuration)).toBe(240);
        await page.getByTestId("toggle-sidebar-fold").click();
        const folded = await sample(page, "[data-testid='drawer-shell']");
        expect(Math.round(folded.transitionDuration)).toBe(240);
        expect(
          await page
            .locator("[data-testid='drawer-shell']")
            .getAttribute("data-sidebar-collapsed")
        ).toBe("");
      } finally {
        await browser.close();
      }
    }, 60_000);

    it("reduced-motion makes drawer/panel/palette durations 0", async () => {
      const { browser, page } = await launchProbe("reduce", "light");
      try {
        await page.getByTestId("open-drawer").click();
        await page.locator("[data-testid='sidebar-scrim']").waitFor({ state: "visible" });
        const scrim = await sample(page, "[data-testid='sidebar-scrim']");
        const drawer = await sample(page, "[data-testid='sidebar']");
        expect(Math.round(scrim.duration)).toBe(0);
        expect(Math.round(drawer.transitionDuration)).toBe(0);

        await page.getByTestId("sidebar-scrim").dispatchEvent("click");
        await page.locator("[data-testid='sidebar-scrim']").waitFor({
          state: "detached",
          timeout: 2_000,
        });

        await page.getByTestId("open-thread").click();
        await page.locator("[data-testid='thread-panel']").waitFor({ state: "attached" });
        const panel = await sample(page, "[data-testid='thread-panel']");
        expect(Math.round(panel.duration)).toBe(0);
        await page.getByTestId("thread-close").click();
        await page.locator("[data-testid='thread-panel']").waitFor({
          state: "detached",
          timeout: 2_000,
        });

        await page.getByTestId("open-palette").click();
        await page.locator("[data-testid='quick-switcher']").waitFor({
          state: "attached",
        });
        const overlay = await sample(page, "[data-testid='quick-switcher-overlay']");
        expect(Math.round(overlay.duration)).toBe(0);
        const dwellStart = await page.evaluate(() => performance.now());
        await page.keyboard.press("Escape");
        await page.locator("[data-testid='quick-switcher']").waitFor({
          state: "detached",
          timeout: 2_000,
        });
        const dwell = await page.evaluate((start) => performance.now() - start, dwellStart);
        expect(dwell, `reduced-motion palette dwell ${dwell}`).toBeLessThan(80);
      } finally {
        await browser.close();
      }
    }, 60_000);
  }
);
