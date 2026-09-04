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
 * (QuickSwitcher, ThreadPanel, Sidebar), both schemes, exit closed-frames > 0,
 * reduced-motion detach ≤20ms. Browser-free half always runs (compiled CSS).
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
  preflight: readFileSync(
    resolve(WEB_ROOT, "../../scripts/design_preflight_web.sh"),
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

/** One source of truth: the preflight allowlist regex, not a TS copy. */
function motionLibAllowlistFromPreflight(script: string): string[] {
  const line = script.match(/^MOTION_LIB_ALLOW_RE='([^']*)'/m);
  if (!line) throw new Error("MOTION_LIB_ALLOW_RE missing from preflight script");
  return line[1]
    .split("|")
    .map((alt) =>
      alt
        .replace(/^\^/, "")
        .replace(/\\/g, "")
        .replace(/:$/, "")
        .replace(/^clients\/web\//, "")
    )
    .filter(Boolean);
}

/** Reconstruct MOTION_LIB_SPEC from bash quoting (`'"'"'` → `'`) and test specifiers. */
function motionLibSpecFromPreflight(script: string): RegExp {
  const line = script.match(/^MOTION_LIB_SPEC='(.*)'$/m);
  if (!line) throw new Error("MOTION_LIB_SPEC missing from preflight script");
  const source = line[1].replace(/'"'"'/g, "'");
  return new RegExp(source);
}

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

  it("compiled .sidebar-drawer uses --motion-fast (unconditional, no browser)", async () => {
    const css = await buildCss(["sidebar-drawer"]);
    expect(css).toMatch(/\.sidebar-drawer/);
    expect(css).toMatch(/var\(--motion-fast\)/);
    expect(css).toMatch(/transition(?:-duration)?:/);
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

  it("allowlist is parsed from the preflight script, not a local copy", () => {
    const fromScript = motionLibAllowlistFromPreflight(FILES.preflight);
    expect(fromScript.sort()).toEqual(
      [
        "src/app/QuickSwitcher.tsx",
        "src/features/sidebar/Sidebar.tsx",
        "src/features/timeline/ThreadPanel.tsx",
      ].sort()
    );
    const imported = [
      ["src/app/QuickSwitcher.tsx", FILES.quickSwitcher],
      ["src/features/timeline/ThreadPanel.tsx", FILES.threadPanel],
      ["src/features/sidebar/Sidebar.tsx", FILES.sidebar],
    ] as const;
    for (const [path, source] of imported) {
      expect(fromScript, path).toContain(path);
      expect(codeOnly(source)).toMatch(/from\s+["']motion\/react["']/);
    }
  });

  it("MOTION_LIB_SPEC covers the shipped family including motion-dom and motion-utils", () => {
    const spec = motionLibSpecFromPreflight(FILES.preflight);
    for (const quoted of [
      '"motion"',
      '"motion/react"',
      '"motion-dom"',
      '"motion-utils"',
      '"framer-motion"',
      '"framer-motion/dom"',
      "'motion-dom'",
    ]) {
      expect(spec.test(quoted), quoted).toBe(true);
    }
    expect(spec.test('"react"')).toBe(false);
    expect(spec.test('"lodash"')).toBe(false);
  });

  it("⌘K consumes MODAL_* constants and AnimatePresence; rows have no item motion", () => {
    const code = codeOnly(FILES.quickSwitcher);
    expect(code).toMatch(/\bMODAL_CONTENT_MOTION\b/);
    expect(code).not.toMatch(/\bPALETTE_ITEM_MOTION\b/);
    expect(code).not.toMatch(/\bmotion-item-fade\b/);
    expect(code).toMatch(/<AnimatePresence>/);
    expect(code).not.toMatch(/\blayout=/);
    expect(code).not.toMatch(/\blayout:/);
    expect(code).not.toMatch(/Command\.Dialog/);
    expect(code).toMatch(/\brestoreDialogOpenerFocus\b/);
  });

  it("ThreadPanel presence is parent-driven; onClose is immediate", () => {
    const code = codeOnly(FILES.threadPanel);
    expect(code).toMatch(/\bPANEL_MOTION\b/);
    expect(code).toContain("playEntrance={isPlayEntrance?.(root.id) ?? false}");
    expect(code).toContain("playEntrance={isPlayEntrance?.(reply.id) ?? false}");
    expect(code).toMatch(/root:\s*Message\s*\|\s*null/);
    expect(code).toMatch(/key=["']thread-panel["']/);
    expect(code).not.toMatch(/\bsetLeaving\b/);
    expect(code).not.toMatch(/\bonExitComplete=/);
    expect(codeOnly(FILES.chatShell)).toMatch(/root=\{thread\}/);
    expect(codeOnly(FILES.chatShell)).not.toMatch(/thread\s*&&\s*channelId/);
  });

  it("ChatShell still binds arrival props on ThreadPanel (R1d)", () => {
    const code = codeOnly(FILES.chatShell);
    expect(code).toMatch(/\bisPlayEntrance=\{timeline\.isPlayEntrance\}/);
    expect(code).toMatch(/\bonEntranceConsumed=\{timeline\.consumeEntrance\}/);
  });

  it("AppShell does not mount a synchronous 390 scrim; Sidebar owns presence", () => {
    const shell = codeOnly(FILES.appShell);
    expect(shell).not.toMatch(/className=["']sidebar-scrim["']/);
    expect(codeOnly(FILES.sidebar)).toMatch(/\bSidebarDrawerScrimLayer\b/);
    expect(codeOnly(FILES.sidebar)).toMatch(/\bDRAWER_SCRIM_MOTION\b/);
    expect(codeOnly(FILES.harness)).toMatch(/<Sidebar\b/);
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
    ):     Promise<{
      name: string;
      duration: number;
      transitionDuration: number;
      state: string | null;
      open: string | null;
      backdropFilter: string;
    }> {
      const raw = await page.locator(selector).evaluate((node) => {
        const motionNode =
          (node.querySelector(":scope > [data-state]") as HTMLElement | null) ??
          node;
        const s = getComputedStyle(motionNode);
        return {
          name: s.animationName,
          duration: s.animationDuration,
          transitionDuration: getComputedStyle(node).transitionDuration,
          state: node.getAttribute("data-state") ?? motionNode.getAttribute("data-state"),
          open: node.getAttribute("data-open"),
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
        open: raw.open,
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
          expect(
            await page.locator("[data-testid='sidebar']").getAttribute("data-open")
          ).toBe("");
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

    it("reduced-motion: durations are 0 and scrim/palette detach within one frame", async () => {
      const { browser, page } = await launchProbe("reduce", "light");
      try {
        await page.getByTestId("open-drawer").click();
        await page.locator("[data-testid='sidebar-scrim']").waitFor({ state: "visible" });
        const scrim = await sample(page, "[data-testid='sidebar-scrim']");
        const drawer = await sample(page, "[data-testid='sidebar']");
        expect(Math.round(scrim.duration)).toBe(0);
        expect(Math.round(drawer.transitionDuration)).toBe(0);

        const scrimClose = await page.evaluate(() => performance.now());
        await page.getByTestId("sidebar-scrim").dispatchEvent("click");
        await page.locator("[data-testid='sidebar-scrim']").waitFor({
          state: "detached",
          timeout: 2_000,
        });
        const scrimDetach = await page.evaluate((start) => performance.now() - start, scrimClose);
        expect(scrimDetach, `reduced-motion scrim detach ${scrimDetach}ms`).toBeLessThan(
          50
        );

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
        const paletteClose = await page.evaluate(() => performance.now());
        await page.keyboard.press("Escape");
        await page.locator("[data-testid='quick-switcher']").waitFor({
          state: "detached",
          timeout: 2_000,
        });
        const paletteDetach = await page.evaluate(
          (start) => performance.now() - start,
          paletteClose
        );
        expect(
          paletteDetach,
          `reduced-motion palette detach ${paletteDetach}ms`
        ).toBeLessThan(50);
        console.info(
          `reduced-motion-detach scrim=${scrimDetach.toFixed(1)}ms palette=${paletteDetach.toFixed(1)}ms`
        );
      } finally {
        await browser.close();
      }
    }, 60_000);

    it("thread reopen during exit at 20/60/100ms shows the requested root", async () => {
      const { browser, page } = await launchProbe("no-preference", "light");
      const ROOT_A = "00000000-0000-7000-8000-000000000301";
      const ROOT_B = "00000000-0000-7000-8000-000000000302";
      const rows: string[] = [];
      try {
        const run = async (
          closeHow: "x" | "escape",
          anchor: "open-thread" | "open-thread-other",
          delayMs: number
        ) => {
          const expected = anchor === "open-thread-other" ? ROOT_B : ROOT_A;
          await page.getByTestId("open-thread").click({ force: true });
          await page.locator("[data-testid='thread-panel']").waitFor({
            state: "attached",
          });
          if (closeHow === "x") {
            await page.getByTestId("thread-close").click();
          } else {
            await page.locator("[data-testid='thread-panel']").press("Escape");
          }
          await page.waitForTimeout(delayMs);
          await page.getByTestId(anchor).click({ force: true });
          const requested = page.locator(
            `[data-testid='thread-panel'][data-root-id='${expected}']`
          );
          await requested.waitFor({ state: "attached", timeout: 2_000 });
          const present = await page.locator("[data-testid='thread-panel']").count();
          const rootId = await requested.first().getAttribute("data-root-id");
          const ok = present > 0 && rootId === expected;
          rows.push(
            `  ${anchor === "open-thread" ? "same" : "other"} anchor @ ${String(delayMs).padStart(3)}ms -> panel ${ok ? "OPENS" : "DOES NOT OPEN"} root=${rootId ?? "none"}`
          );
          expect(present, `${closeHow} ${anchor} @ ${delayMs}ms`).toBeGreaterThan(0);
          expect(rootId).toBe(expected);
          await requested.getByTestId("thread-close").click();
          await page.locator("[data-testid='thread-panel']").waitFor({
            state: "detached",
            timeout: 2_000,
          });
        };

        for (const delay of [20, 60, 100] as const) {
          await run("x", "open-thread", delay);
          await run("x", "open-thread-other", delay);
        }
        await run("escape", "open-thread", 20);
        await run("escape", "open-thread", 100);

        await page.getByTestId("open-thread").click({ force: true });
        await page.locator("[data-testid='thread-panel']").waitFor({ state: "attached" });
        await Promise.all([
          page.getByTestId("thread-close").click(),
          page.getByTestId("open-thread-other").click({ force: true }),
        ]);
        const raceCount = await page.locator("[data-testid='thread-panel']").count();
        rows.push(`  real-mouse race -> panel count ${raceCount}`);
        expect(raceCount).toBe(1);
        console.info(`dead-window-sweep\n${rows.join("\n")}`);
      } finally {
        await browser.close();
      }
    }, 60_000);

    it("⌘K filter keystrokes do not replay item fade; focus returns to opener", async () => {
      const { browser, page } = await launchProbe("no-preference", "light");
      try {
        await page.evaluate(() => {
          const w = window as Window & {
            __itemAnim?: number;
            __containerAnim?: number;
          };
          w.__itemAnim = 0;
          w.__containerAnim = 0;
          document.addEventListener(
            "animationstart",
            (event) => {
              const target = event.target;
              if (!(target instanceof Element)) return;
              if (target.closest("[cmdk-item]")) {
                w.__itemAnim = (w.__itemAnim ?? 0) + 1;
                return;
              }
              if (target.closest("[data-testid='quick-switcher']")) {
                w.__containerAnim = (w.__containerAnim ?? 0) + 1;
              }
            },
            true
          );
        });
        await page.getByTestId("open-palette").click();
        await page.locator("[data-testid='quick-switcher']").waitFor({
          state: "visible",
        });
        const afterOpen = await page.evaluate(() => {
          const w = window as Window & {
            __itemAnim?: number;
            __containerAnim?: number;
          };
          return { items: w.__itemAnim ?? 0, container: w.__containerAnim ?? 0 };
        });
        expect(afterOpen.container, `container animationstart on open ${afterOpen.container}`).toBeLessThanOrEqual(
          1
        );
        await page.evaluate(() => {
          const w = window as Window & { __itemAnim?: number };
          w.__itemAnim = 0;
        });
        await page.locator("[data-testid='quick-switcher-input']").click();
        await page.keyboard.type("abc");
        const counts = await page.evaluate(() => {
          const w = window as Window & {
            __itemAnim?: number;
            __containerAnim?: number;
          };
          return { items: w.__itemAnim ?? 0, container: w.__containerAnim ?? 0 };
        });
        expect(counts.items, `item animationstart ${counts.items}`).toBe(0);

        await page.keyboard.press("Escape");
        await page.locator("[data-testid='quick-switcher']").waitFor({
          state: "detached",
          timeout: 2_000,
        });
        const focused = await page.evaluate(
          () => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName
        );
        expect(focused, `focus after palette close: ${focused}`).toBe("open-palette");
        console.info(
          `palette-keystrokes open-container=${afterOpen.container} type-items=${counts.items} focus=${focused}`
        );
      } finally {
        await browser.close();
      }
    }, 60_000);
  }
);
