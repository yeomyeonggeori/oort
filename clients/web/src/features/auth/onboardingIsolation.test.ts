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
    expect(landing).toContain("bg-onboarding-accent");
    expect(landing).toContain("text-onboarding-on-accent");
    expect(landing).not.toMatch(/\bbg-accent\b/);
    expect(landing).not.toMatch(/\btext-accent\b/);
    expect(landing).not.toMatch(/\btext-signal-text\b/);
  });

  it("shows the owner-chosen 코메토 reference as the S0 hero, not a recolourable mark (#2732)", () => {
    expect(landing).toMatch(/<KomettoMark\b/);
    expect(landing).not.toMatch(/<OortMark\b/);
  });

  it("pins S0 and brand lockup to the Dawn accent pair", () => {
    expect(tokens).toMatch(
      /\.onboarding-landing,\s*\n\s*\.brand-lockup\s*\{/
    );
    expect(landing).toContain("brand-lockup");
    expect(connect).toContain("brand-lockup");
    expect(claim).toContain("brand-lockup");
  });

  // DS2-1(#2713): 신호의 글자 역할은 --signal-text 이고 `text-accent` 는 걷혔다.
  // 마크는 같은 신호색을 입으므로 같은 가둠(`.brand-lockup`)이 그대로 필요하다.
  it("wraps every OortMark painted with the signal text colour in .brand-lockup", () => {
    const hits: { file: string; near: string }[] = [];
    for (const file of sourceFiles(srcRoot)) {
      const source = readFileSync(file, "utf8");
      const re = /<OortMark\b([^>]*)\/?>/g;
      for (const match of source.matchAll(re)) {
        const attrs = match[1] ?? "";
        if (!/\btext-(?:accent|signal-text)\b/.test(attrs)) continue;
        if (/\btext-onboarding-accent\b/.test(attrs)) continue;
        const from = Math.max(0, (match.index ?? 0) - 400);
        hits.push({
          file: file.slice(srcRoot.length),
          near: source.slice(from, match.index),
        });
      }
    }
    // Account, profile (S3), claim, and post-claim S2. The gateway moved onto
    // the onboarding 2.0 frame (#2807) and says its question through
    // KomettoGuide, not a lockup. A fifth site without `.brand-lockup` nearby
    // is leftover below.
    expect(hits, "OortMark signal-text sites").toHaveLength(4);
    const leftover = hits.filter((hit) => !hit.near.includes("brand-lockup"));
    expect(leftover, leftover.map((hit) => hit.file).join(", ")).toEqual([]);
  });
});
