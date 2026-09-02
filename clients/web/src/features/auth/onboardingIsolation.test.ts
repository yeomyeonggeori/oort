import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const landing = readFileSync(new URL("./LandingStep.tsx", import.meta.url), "utf8");
const connect = readFileSync(new URL("./ConnectPage.tsx", import.meta.url), "utf8");
const claim = readFileSync(new URL("./ClaimPage.tsx", import.meta.url), "utf8");
const tokens = readFileSync(
  new URL("../../design/tokens.css", import.meta.url),
  "utf8"
);
const srcRoot = fileURLToPath(new URL("../..", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry) ? [path] : [];
  });
}

describe("onboarding S0 and brand lockup stay outside custom accent", () => {
  it("paints S0 with onboarding tokens, not --accent", () => {
    expect(landing).toContain("bg-onboarding-space");
    expect(landing).toContain("text-onboarding-accent");
    expect(landing).toContain("bg-onboarding-accent");
    expect(landing).toContain("text-onboarding-on-accent");
    expect(landing).not.toMatch(/\bbg-accent\b/);
    expect(landing).not.toMatch(/\btext-accent\b/);
  });

  it("pins S0 and brand lockup to the Dawn accent pair", () => {
    expect(tokens).toMatch(
      /\.onboarding-landing,\s*\n\s*\.brand-lockup\s*\{/
    );
    expect(landing).toContain("brand-lockup");
    expect(connect).toContain("brand-lockup");
    expect(claim).toContain("brand-lockup");
  });

  it("wraps every OortMark painted with text-accent in .brand-lockup", () => {
    const hits: { file: string; near: string }[] = [];
    for (const file of sourceFiles(srcRoot)) {
      const source = readFileSync(file, "utf8");
      const re = /<OortMark\b([^>]*)\/?>/g;
      for (const match of source.matchAll(re)) {
        const attrs = match[1] ?? "";
        if (!/\btext-accent\b/.test(attrs)) continue;
        if (/\btext-onboarding-accent\b/.test(attrs)) continue;
        const from = Math.max(0, (match.index ?? 0) - 400);
        hits.push({
          file: file.slice(srcRoot.length),
          near: source.slice(from, match.index),
        });
      }
    }
    expect(hits, "OortMark text-accent sites").toHaveLength(3);
    const leftover = hits.filter((hit) => !hit.near.includes("brand-lockup"));
    expect(leftover, leftover.map((hit) => hit.file).join(", ")).toEqual([]);
  });
});
