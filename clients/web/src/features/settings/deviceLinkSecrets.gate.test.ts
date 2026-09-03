import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deviceLinkFixtureDeepLink, deviceLinkFixtureToken } from "./deviceLinkFixture";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = join(HERE, "../..");
const WEB_ROOT = join(HERE, "../../..");
const REPO_ROOT = join(WEB_ROOT, "../..");

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const path = join(dir, entry);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, acc);
    else acc.push(path);
  }
  return acc;
}

function itTitles(source: string): string[] {
  const titles: string[] = [];
  const re =
    /\b(?:it|test|describe)\(\s*(?:async\s*)?(?:function\s*)?[`"']([^`"']+)[`"']/g;
  for (const match of source.matchAll(re)) titles.push(match[1]);
  return titles;
}

describe("device-link secrets grep-gate", () => {
  it("voucher plaintext stays out of titles, snapshots, and capture frame names", () => {
    const token = deviceLinkFixtureToken();
    const deepLink = deviceLinkFixtureDeepLink();
    const secrets = [token, deepLink];

    const testFiles = walk(WEB_SRC).filter(
      (path) => path.endsWith(".test.ts") || path.endsWith(".test.tsx")
    );
    for (const file of testFiles) {
      const source = readFileSync(file, "utf8");
      for (const title of itTitles(source)) {
        for (const secret of secrets) {
          expect(title, file).not.toContain(secret);
        }
      }
    }

    const snapFiles = walk(WEB_ROOT).filter((path) => path.endsWith(".snap"));
    for (const file of snapFiles) {
      const source = readFileSync(file, "utf8");
      for (const secret of secrets) {
        expect(source, file).not.toContain(secret);
      }
    }

    const capture = readFileSync(
      join(WEB_ROOT, "scripts/capture-screens.mjs"),
      "utf8"
    );
    const frameNames = [
      ...capture.matchAll(/\$\{OUT_DIR\}\/([^`"'\s]+)/g),
    ].map((match) => match[1]);
    expect(frameNames.length).toBeGreaterThan(10);
    for (const name of frameNames) {
      for (const secret of secrets) {
        expect(name, name).not.toContain(secret);
      }
    }

    const designDir = join(WEB_ROOT, "artifacts/design");
    try {
      for (const name of readdirSync(designDir)) {
        for (const secret of secrets) {
          expect(name).not.toContain(secret);
        }
      }
    } catch {
      // Capture artifacts are produced by capture:design, not by unit tests.
    }

    const manifest = join(REPO_ROOT, "artifacts/design");
    try {
      for (const name of readdirSync(manifest)) {
        for (const secret of secrets) {
          expect(name).not.toContain(secret);
        }
      }
    } catch {
      // optional
    }
  });
});
