import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deviceLinkFixtureDeepLink, deviceLinkFixtureToken } from "./deviceLinkFixture";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = join(HERE, "../..");
const WEB_ROOT = join(HERE, "../../..");

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

function voucherSecrets(): string[] {
  const token = deviceLinkFixtureToken();
  const deepLink = deviceLinkFixtureDeepLink();
  return [
    token,
    deepLink,
    encodeURIComponent(token),
    encodeURIComponent(deepLink),
  ];
}

function assertNamesClean(names: string[], secrets: string[], where: string): void {
  for (const name of names) {
    for (const secret of secrets) {
      expect(name, `${where}: ${name}`).not.toContain(secret);
    }
  }
}

describe("device-link secrets grep-gate", () => {
  it("voucher plaintext stays out of titles, snapshots, and capture templates", () => {
    const secrets = voucherSecrets();

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
    assertNamesClean(frameNames, secrets, "capture template");
    expect(capture).not.toMatch(/OUT_DIR\}[^;`]*CAPTURE_TOKEN/);
    expect(capture).not.toMatch(/CAPTURE_TOKEN[^;`]*\.png/);
  });

  it("fails when a produced frame is named with the fixture voucher", () => {
    const token = deviceLinkFixtureToken();
    const secrets = voucherSecrets();
    const designDir = join(WEB_ROOT, "artifacts/design");
    mkdirSync(designDir, { recursive: true });
    const planted = join(designDir, `probe-${token}.png`);
    writeFileSync(planted, "");
    let bitten = false;
    try {
      assertNamesClean(readdirSync(designDir), secrets, "planted frame");
    } catch {
      bitten = true;
    } finally {
      unlinkSync(planted);
    }
    expect(bitten).toBe(true);
  });

  it("produced capture frames do not contain the harness voucher", () => {
    const secrets = voucherSecrets();
    const designDir = join(WEB_ROOT, "artifacts/design");
    if (!existsSync(designDir)) {
      throw new Error(
        "device-link secrets gate: artifacts/design is missing (run capture:design)"
      );
    }
    assertNamesClean(readdirSync(designDir), secrets, "artifacts/design");
  });
});
