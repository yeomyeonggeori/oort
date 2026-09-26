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
