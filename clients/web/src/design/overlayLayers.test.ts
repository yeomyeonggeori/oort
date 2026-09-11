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
 * `z-10` / `z-50`. Remaining raw z-index is a closed allowlist of local
 * stacking (sticky headers, rail marker) that does not compete at root.
 */

const TOKENS_PATH = fileURLToPath(new URL("./tokens.css", import.meta.url));
const CSS = readFileSync(TOKENS_PATH, "utf8");
const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));
const require_ = createRequire(import.meta.url);
const DESIGN = dirname(TOKENS_PATH);

const LAYER_ORDER = [
  "content-float",
  "overlay-scrim",
  "overlay-surface",
  "confirm-ephemeral",
] as const;

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
] as const;

/** Local stacking that is not an overlay. Documented leftover. */
const RAW_Z_ALLOWLIST: Record<string, string> = {
  "features/sidebar/WorkspaceRail.tsx":
    "rail current-workspace marker; local to the tile",
  "features/work/WorkSessionDetail.tsx":
    "sticky section header inside the session scrollport",
  "features/timeline/ArtifactCard.tsx":
    "sticky filename inside a code card so the next file does not paint over it",
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

function layerValue(name: string): number {
  const match = CSS.match(
    new RegExp(`--layer-${name}:\\s*(\\d+);`)
  );
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
  it("declares four named layers in increasing order", () => {
    const values = LAYER_ORDER.map(layerValue);
    expect(values).toEqual([1, 2, 3, 4]);
    for (let i = 1; i < values.length; i++) {
      expect(values[i], LAYER_ORDER[i]).toBeGreaterThan(values[i - 1]!);
    }
    expect(values[0]).toBeLessThan(10);
  });

  it("exposes layer-* utilities that emit the token", async () => {
    const compiler = await compile(CSS, { base: DESIGN, loadStylesheet });
    const built = compiler.build(
      LAYER_ORDER.map((name) => `layer-${name}`)
    );
    for (const name of LAYER_ORDER) {
      expect(built).toContain(`--layer-${name}`);
      expect(built).toMatch(
        new RegExp(
          `\\.layer-${name}[^{]*\\{[^}]*z-index:\\s*var\\(--layer-${name}\\)`
        )
      );
    }
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
    expect(dialog).toContain('data-overlay-layer="scrim"');
    expect(dialog).toContain('data-overlay-layer="surface"');

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

  it("remaining raw z-index is a closed allowlist", () => {
    const leftover: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      const rel = file.slice(SRC_DIR.length + 1);
      if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue;
      const code = codeOnly(readFileSync(file, "utf8"));
      if (/\bz-(0|10|20|30|40|50)\b/.test(code)) leftover.push(rel);
    }
    leftover.sort();
    expect(leftover).toEqual(Object.keys(RAW_Z_ALLOWLIST).sort());
  });
});
