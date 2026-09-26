import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const welcome = readFileSync(new URL("./WelcomeStep.tsx", import.meta.url), "utf8");
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
  // 옛 S0(심우주 랜딩)은 D0(#2808)이 됐다. D0은 온보딩 2.0 틀(새벽하늘 canvas)
  // 위에 서고, 신호색은 포커스와 진행 점에만 쓴다(ADR-0193 D11).
  it("keeps D0 off --accent and off signal text", () => {
    expect(welcome).not.toMatch(/\bbg-accent\b/);
    expect(welcome).not.toMatch(/\btext-accent\b/);
    expect(welcome).not.toMatch(/\btext-signal-text\b/);
    expect(welcome).not.toMatch(/\bbg-signal\b/);
  });

  it("shows 코메토 as the D0 hero, not a recolourable mark (#2732)", () => {
    expect(welcome).toMatch(/<KomettoFace\b[^>]*size="hero"/);
    expect(welcome).not.toMatch(/<OortMark\b/);
    expect(connect).not.toMatch(/<OortMark\b/);
  });

  it("pins the claim lockup to the Dawn accent pair", () => {
    expect(tokens).toMatch(
      /\.onboarding-landing,\s*\n\s*\.brand-lockup\s*\{/
    );
    // claim(D1″)도 온보딩 2.0 틀로 옮겨 락업이 없다(#2811). 코메토가 질문을 말한다.
    expect(claim).not.toMatch(/<OortMark\b/);
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
    // None left. The login and invite screens (#2808·#2809·#2810) and claim +
    // post-claim S1·S2 (#2811) moved onto the onboarding 2.0 frame and say
    // their question through KomettoGuide, not a lockup. A new signal-coloured
    // OortMark must come back with `.brand-lockup` nearby and raise this count.
    expect(hits, "OortMark signal-text sites").toHaveLength(0);
    const leftover = hits.filter((hit) => !hit.near.includes("brand-lockup"));
    expect(leftover, leftover.map((hit) => hit.file).join(", ")).toEqual([]);
  });
});
