import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const connectPageSource = readFileSync(
  fileURLToPath(new URL("./ConnectPage.tsx", import.meta.url)),
  "utf8"
);
const landingStepSource = readFileSync(
  fileURLToPath(new URL("./LandingStep.tsx", import.meta.url)),
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

describe("S0 lockup hierarchy (#1882 H-1/M-1)", () => {
  it("does not borrow text-title or pane-sm for the hero lockup", () => {
    expect(landingStepSource).not.toMatch(
      /onboarding-wordmark[^"'`]*text-title/
    );
    expect(landingStepSource).not.toMatch(
      /onboarding-tagline[^"'`]*max-w-pane-sm/
    );
    expect(landingStepSource).toContain("max-w-onboarding-copy");
  });

  it("names an onboarding wordmark size off the closed text scale", () => {
    expect(tokensCss).toMatch(/--font-onboarding-wordmark:/);
    expect(tokensCss).toMatch(/--spacing-onboarding-copy:\s*360px;/);
    const word = tokensCss.match(/\.onboarding-wordmark \{[\s\S]*?\n\}/)?.[0];
    expect(word).toBeTruthy();
    expect(word).toContain("var(--font-onboarding-wordmark)");
    expect(word).toContain("4vw");
    expect(tokensCss).not.toMatch(/--text-onboarding-wordmark:/);
  });
});

