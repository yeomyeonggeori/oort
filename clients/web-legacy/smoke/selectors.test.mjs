// =============================================================================
// Guard: every testid the browser smoke targets must be one the app renders.
//
// Why this exists (#1182): `login-timeline.smoke.mjs` and `ApprovalCard.tsx`
// were landed in sync by 4a564d5f, then cdcf3229 (#577) renamed the card's
// status element `approval-state` -> `approval-status-chip` without touching
// the smoke. The smoke kept waiting 20s for an element that no longer existed
// and the run stalled there — for 18 days nobody saw it, because the ONLY
// detector was a ~50-minute Docker browser gate that was itself red further
// upstream (#1181 B2/B3).
//
// The drift is mechanically detectable in milliseconds, so detect it here, in
// a lane that actually runs (`npm run test`, web profile step 7) instead of
// one that runs once a fortnight. This is a STATIC check and makes no claim
// about behaviour — it only says the selectors address something real. The
// browser smoke remains the thing that proves the round-trips.
//
// Scope note: the check is one-directional on purpose. A testid rendered but
// not yet smoked is normal (most of them); a testid smoked but not rendered
// is always a bug — either a stale selector or a deleted surface.
// =============================================================================

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SMOKE_DIR = fileURLToPath(new URL(".", import.meta.url));
const SRC_DIR = join(SMOKE_DIR, "..", "src");

/** Every .tsx under src (the only file type that renders a testid today). */
function tsxFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(full);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [full] : [];
  });
}

/**
 * testids the app renders. Every `data-testid` in the tree is a static string
 * literal; if a dynamic one (`data-testid={expr}`) is ever introduced, the
 * companion test below fails so this reader is fixed rather than silently
 * under-reporting and turning this guard into a false alarm.
 */
function renderedTestIds() {
  const ids = new Set();
  for (const file of tsxFiles(SRC_DIR)) {
    const source = readFileSync(file, "utf8");
    for (const [, id] of source.matchAll(/data-testid="([^"]+)"/g)) ids.add(id);
  }
  return ids;
}

/** testids the smoke addresses, in either idiom it uses. */
function smokedTestIds() {
  const source = readFileSync(join(SMOKE_DIR, "login-timeline.smoke.mjs"), "utf8");
  const ids = new Set();
  for (const [, id] of source.matchAll(/getByTestId\("([^"]+)"\)/g)) ids.add(id);
  for (const [, id] of source.matchAll(/\[data-testid="([^"]+)"\]/g)) ids.add(id);
  return ids;
}

describe("browser smoke selectors", () => {
  it("only targets testids the app actually renders", () => {
    const rendered = renderedTestIds();
    const orphans = [...smokedTestIds()]
      .filter((id) => !rendered.has(id))
      .sort();
    expect(orphans, `smoke waits on testid(s) nothing renders: ${orphans.join(", ")}`).toEqual([]);
  });

  it("reads a tree whose testids are all static literals", () => {
    const dynamic = tsxFiles(SRC_DIR).filter((file) =>
      readFileSync(file, "utf8").includes("data-testid={")
    );
    expect(dynamic, "a dynamic data-testid was introduced; teach renderedTestIds() to read it before this guard can be trusted").toEqual([]);
  });

  it("is wired to something — the smoke addresses testids at all", () => {
    // A rename of the smoke's locator idiom would empty the reader and make
    // the orphan check vacuously green. 4a564d5f's smoke targets ~30.
    expect(smokedTestIds().size).toBeGreaterThan(20);
  });
});
