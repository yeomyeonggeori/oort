import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const connectPageSource = readFileSync(
  fileURLToPath(new URL("./ConnectPage.tsx", import.meta.url)),
  "utf8"
);
const welcomeStepSource = readFileSync(
  fileURLToPath(new URL("./WelcomeStep.tsx", import.meta.url)),
  "utf8"
);
const tokensCss = readFileSync(
  fileURLToPath(new URL("../../design/tokens.css", import.meta.url)),
  "utf8"
);

describe("S1/S2 step chrome contract (#1882)", () => {
  it("uses AppTitlebar drag/inset rules and a labelled ghost back button", () => {
    expect(connectPageSource).toContain("titlebarDragProps(IS_TAURI)");
    expect(connectPageSource).toContain("onboarding-step-chrome");
    expect(connectPageSource).toContain("ArrowLeft");
    expect(connectPageSource).toContain('variant="ghost"');
    expect(connectPageSource).toContain("onPointerDown");
    expect(connectPageSource).not.toMatch(
      /data-testid="onboarding-back"[\s\S]{0,500}underline/
    );
  });

  it("opens the traffic-light inset only on the drag-region attribute", () => {
    const block = tokensCss.match(
      /@utility onboarding-step-chrome \{[\s\S]*?\n\}/
    )?.[0];
    expect(block).toBeTruthy();
    expect(block).toContain("&[data-tauri-drag-region]");
    expect(block).toContain("padding-inline-start: var(--titlebar-inset)");
    expect(block).not.toContain("display: none");
  });
});

describe("머리 줄의 칸은 자식 순서가 아니라 자리로 정해진다 (#5101, 검증 줄 M1)", () => {
  // 소스 검사이고 렌더 검사가 아니다: jsdom은 격자를 배치하지 않는다. 렌더된 칩의 자리(D0와 D1의 오른쪽 끝,
  // 1440·390)는 `scripts/capture-5101.mjs`가 번들 Chromium으로 잰다. 이 단정은 그 수리가 되돌려지는 것을
  // 단위 시험이 먼저 알려 주는 한 줄이다.
  const frameRule = (selector: string) =>
    tokensCss.match(
      new RegExp(
        `\\.onboarding-frame > \\.onboarding-step-chrome${selector} \\{[\\s\\S]*?\\n\\}`
      )
    )?.[0];

  it("세 칸(뒤로 · 점 · 끝)이고, 첫 자식은 첫째 칸·끝 자식(언어 칩)은 진행 점이 없어도 셋째 칸에 못 박힌다", () => {
    expect(frameRule("")).toContain("grid-template-columns: 1fr auto 1fr");
    const first = frameRule(" > :first-child");
    expect(first).toContain("grid-column: 1");
    expect(first).toContain("justify-self: start");
    const last = frameRule(" > :last-child");
    expect(last).toContain("grid-column: 3");
    expect(last).toContain("justify-self: end");
  });
});

describe("D0 hero lockup (#2808, 시안 D0)", () => {
  it("stacks 코메토 hero, wordmark and one-line intro on the left", () => {
    expect(welcomeStepSource).toMatch(/<KomettoFace[^>]*size="hero"/);
    expect(welcomeStepSource).toContain("onboarding-welcome-wordmark");
    expect(welcomeStepSource).toContain(
      "사람과 에이전트가 같은 자리에서 일하는 메신저."
    );
    // 위계는 크기가 진다: 워드마크는 닫힌 글자 사다리를 빌리지 않는다.
    expect(welcomeStepSource).not.toMatch(
      /onboarding-welcome-wordmark[^"'`]*text-(?:title|display)/
    );
  });

  it("takes the mockup grid and wordmark values", () => {
    const grid = tokensCss.match(/\.onboarding-welcome \{[\s\S]*?\n\}/)?.[0];
    expect(grid).toContain(
      "grid-template-columns: 1fr var(--spacing-onboarding-col)"
    );
    expect(grid).toContain("gap: 64px");
    expect(grid).toContain("max-inline-size: 1000px");
    const word = tokensCss.match(
      /\.onboarding-welcome-wordmark \{[\s\S]*?\n\}/
    )?.[0];
    expect(word).toContain("font-size: 40px");
    expect(word).toContain("font-weight: 800");
  });
});
