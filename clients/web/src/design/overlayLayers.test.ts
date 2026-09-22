import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Overlay stacking names (#2044 #2075 #1919).
 *
 * The numerals live once in tokens.css. Surfaces write `layer-*`, never
 * `z-10` / `z-50`.
 *
 * What this file can and cannot see (#2485 R1 H-2). Everything here is text:
 * it reads sources and compiles CSS. It cannot resolve a stacking root, so it
 * cannot tell a `z-10` that is local to its card from one that competes with
 * every overlay in the app — the first draft's allowlist asserted three file
 * **paths** while its comment claimed a **property**, and the property was
 * false in two of the three. The property is measured in the Playwright lane
 * (`scripts/capture-overlay-layers.mjs` → root sweep, which fails when any
 * element outside the named scale resolves a numeric z-index in the document's
 * stacking root). What is left here is the part text can actually hold:
 *
 *   1. the order and the **floor** of the scale (above every Tailwind numeral
 *      a leftover class can still write), so the range can never again be
 *      chosen so that leftovers outrank named layers;
 *   2. one spelling per layer;
 *   3. every leftover `z-*` file is a known file **and pairs with `isolate`**
 *      on the owner that scopes it — the mechanical shadow of the runtime
 *      property, demoted to a secondary guard;
 *   4. the `data-overlay-layer` contract on all six surfaces that set it.
 */

const TOKENS_PATH = fileURLToPath(new URL("./tokens.css", import.meta.url));
const CSS = readFileSync(TOKENS_PATH, "utf8");
const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));
const require_ = createRequire(import.meta.url);
const DESIGN = dirname(TOKENS_PATH);

const LAYER_ORDER = ["content-float", "overlay-scrim", "overlay-surface"] as const;

/** The top of Tailwind's stock `z-*` scale — what a leftover class can write. */
const RAW_Z_CEILING = 50;

const MUST_USE_NAMED_LAYER = [
  "design/ui/dialog.tsx",
  "design/ui/popover.tsx",
  "design/ui/dropdown-menu.tsx",
  "design/ui/context-menu.tsx",
  "app/QuickSwitcher.tsx",
  "features/timeline/UnreadPill.tsx",
  "features/timeline/UnfurlCards.tsx",
  "features/timeline/MessageActions.tsx",
  "features/timeline/MessageRow.tsx",
  "features/drafts/DraftsRoute.tsx",
  "features/emoji/EmojiPickerPanel.tsx",
  "features/sidebar/Sidebar.tsx",
  "features/ade/AdeDrawer.tsx",
] as const;

/**
 * Every file that sets `data-overlay-layer`, and the values it sets.
 *
 * The attribute is a review/observability contract: the capture lane and every
 * probe key on it, so a surface that stops setting it stops being measurable
 * (#2485 R1 N-3 — the first draft asserted `dialog.tsx` alone).
 */
const OVERLAY_LAYER_ATTR: Record<string, readonly string[]> = {
  "design/ui/dialog.tsx": ["scrim", "surface"],
  "design/ui/popover.tsx": ["surface"],
  "design/ui/dropdown-menu.tsx": ["surface"],
  "design/ui/context-menu.tsx": ["surface"],
  "app/QuickSwitcher.tsx": ["surface"],
  "features/ade/AdeDrawer.tsx": ["surface", "scrim"],
  "features/sidebar/Sidebar.tsx": ["surface", "scrim"],
};

/**
 * Leftover raw `z-*`, and the owner that scopes it.
 *
 * This is not the claim that the leftover is local — the capture lane's root
 * sweep is what measures that. It is the claim that a leftover only exists
 * where the file also creates a stacking context for it. A `z-10` added to a
 * file with no `isolate` is a file that reaches the document root.
 */
const RAW_Z_ALLOWLIST: Record<string, string> = {
  "features/sidebar/WorkspaceRail.tsx":
    "rail current-workspace marker; scoped by `isolate` on the tile",
  "features/work/WorkSessionDetail.tsx":
    "sticky section header; scoped by `isolate` on the session scrollport",
  "features/timeline/ArtifactCard.tsx":
    "sticky filename so the next file does not paint over it; scoped by `isolate` on the <details>",
};

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<!:)\/\/.*$/gm, "");
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Index just past the `>` that closes the JSX opening tag holding `from`. */
function openingTagEnd(code: string, from: number): number {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const ch = code[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) return i + 1;
  }
  return code.length;
}

function layerValue(name: string): number {
  const match = CSS.match(new RegExp(`--layer-${name}:\\s*(\\d+);`));
  if (!match) throw new Error(`missing --layer-${name}`);
  return Number(match[1]);
}

async function loadStylesheet(id: string, base: string) {
  if (id === "tailwindcss" || id.endsWith("tailwindcss/index.css")) {
    const path = require_.resolve("tailwindcss/index.css");
    return { path, base: dirname(path), content: readFileSync(path, "utf8") };
  }
  const path = id.startsWith(".") || id.startsWith("/") ? `${base}/${id}` : id;
  return { path, base: dirname(path), content: readFileSync(path, "utf8") };
}

describe("overlay layer tokens", () => {
  it("declares three named layers in increasing order", () => {
    const values = LAYER_ORDER.map(layerValue);
    expect(values).toEqual([100, 200, 300]);
    for (let i = 1; i < values.length; i++) {
      expect(values[i], LAYER_ORDER[i]).toBeGreaterThan(values[i - 1]!);
    }
  });

  it("puts the whole band above every raw Tailwind z-index", () => {
    // The R1 blockers in one assertion. If the floor drops back under the
    // stock scale, a leftover `z-10`/`z-50` outranks the scrim and the panel
    // again, which is exactly what painted a sticky filename across the ⌘K
    // palette and cut a nav row in half inside the 390px drawer.
    for (const name of LAYER_ORDER) {
      expect(layerValue(name), name).toBeGreaterThan(RAW_Z_CEILING);
    }
  });

  it("names no layer above the floating overlay surface", () => {
    // ADR-0182's three ephemeral-confirmation forms are all inside a surface
    // or in flow, so there is no fourth name and no consumer for one
    // (#2485 R1 H-1). A name with no surface is a rule with no origin.
    expect(CSS).not.toContain("--layer-confirm-ephemeral");
    const top = Math.max(...LAYER_ORDER.map(layerValue));
    expect(layerValue("overlay-surface")).toBe(top);
  });

  it("keeps one spelling per layer", () => {
    // `@theme --z-index-*` would compile `z-content-float` as a second legal
    // spelling of the same axis, with no user (#2485 R1 N-1).
    for (const name of LAYER_ORDER) {
      expect(CSS, name).not.toContain(`--z-index-${name}`);
    }
  });

  it("exposes layer-* utilities that emit the token", async () => {
    const compiler = await compile(CSS, { base: DESIGN, loadStylesheet });
    const built = compiler.build([
      ...LAYER_ORDER.map((name) => `layer-${name}`),
      ...LAYER_ORDER.map((name) => `z-${name}`),
    ]);
    for (const name of LAYER_ORDER) {
      expect(built).toContain(`--layer-${name}`);
      expect(built).toMatch(
        new RegExp(
          `\\.layer-${name}[^{]*\\{[^}]*z-index:\\s*var\\(--layer-${name}\\)`
        )
      );
      expect(built, `z-${name} must not compile`).not.toMatch(
        new RegExp(`\\.z-${name}[^{]*\\{`)
      );
    }
  });

  it("keeps every numeral in tokens.css on the named scale", () => {
    // The .ts/.tsx sweep below never looked at CSS, and every drawer, pane and
    // scrim writes its z-index there rather than in a class.
    const raw = CSS.split("\n")
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => /^\s*z-index:/.test(line))
      .filter(([, line]) => !/z-index:\s*var\(--layer-/.test(line));
    expect(raw).toEqual([]);
  });

  it("overlay and floating-timeline files do not write z-10/z-50", () => {
    for (const rel of MUST_USE_NAMED_LAYER) {
      const code = codeOnly(readFileSync(`${SRC_DIR}/${rel}`, "utf8"));
      expect(code, rel).not.toMatch(/\bz-(0|10|20|30|40|50)\b/);
    }
  });

  it("dialog overlay/content and UnreadPill consume the named layers", () => {
    const dialog = codeOnly(
      readFileSync(`${SRC_DIR}/design/ui/dialog.tsx`, "utf8")
    );
    expect(dialog).toContain("layer-overlay-scrim");
    expect(dialog).toContain("layer-overlay-surface");

    const pill = codeOnly(
      readFileSync(`${SRC_DIR}/features/timeline/UnreadPill.tsx`, "utf8")
    );
    expect(pill).toContain("layer-content-float");

    const toolbar = codeOnly(
      readFileSync(`${SRC_DIR}/features/timeline/MessageActions.tsx`, "utf8")
    );
    expect(toolbar).toContain("layer-content-float");

    const unfurl = codeOnly(
      readFileSync(`${SRC_DIR}/features/timeline/UnfurlCards.tsx`, "utf8")
    );
    expect(unfurl).toContain("layer-content-float");
  });

  it("every surface that sets data-overlay-layer sets it after {...props}", () => {
    for (const [rel, values] of Object.entries(OVERLAY_LAYER_ATTR)) {
      const code = codeOnly(readFileSync(`${SRC_DIR}/${rel}`, "utf8"));
      const attrs = [...code.matchAll(/data-overlay-layer=(\{[^}]*\}|"[^"]*")/g)];
      expect(attrs.length, `${rel} attribute count`).toBe(values.length);
      for (const value of values) {
        expect(code, `${rel} → ${value}`).toMatch(
          new RegExp(`data-overlay-layer=(\\{[^}]*"${value}"[^}]*\\}|"${value}")`)
        );
      }
      // A caller must not be able to blank the contract with a spread
      // (#2485 R1 N-2): inside its own element, the attribute comes after
      // every `{...` spread, so nothing downstream can overwrite it.
      for (const attr of attrs) {
        const rest = code.slice(attr.index!, openingTagEnd(code, attr.index!));
        expect(rest, `${rel}: no spread may follow data-overlay-layer`).not.toMatch(
          /\{\.\.\./
        );
      }
    }
  });

  it("remaining raw z-index is a closed allowlist, each scoped by isolate", () => {
    const leftover: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      const rel = file.slice(SRC_DIR.length + 1);
      if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue;
      const code = codeOnly(readFileSync(file, "utf8"));
      if (/\bz-(0|10|20|30|40|50)\b/.test(code)) leftover.push(rel);
    }
    leftover.sort();
    expect(leftover).toEqual(Object.keys(RAW_Z_ALLOWLIST).sort());
    for (const rel of leftover) {
      const code = codeOnly(readFileSync(`${SRC_DIR}/${rel}`, "utf8"));
      expect(code, `${rel} must isolate its leftover`).toMatch(
        /(^|["\s])isolate(\s|"|$)/m
      );
    }
  });
});
