import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const connectPageSource = readFileSync(
  fileURLToPath(new URL("./ConnectPage.tsx", import.meta.url)),
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

