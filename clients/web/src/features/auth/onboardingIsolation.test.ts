import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const landing = readFileSync(new URL("./LandingStep.tsx", import.meta.url), "utf8");
const connect = readFileSync(new URL("./ConnectPage.tsx", import.meta.url), "utf8");
const claim = readFileSync(new URL("./ClaimPage.tsx", import.meta.url), "utf8");
const tokens = readFileSync(
  new URL("../../design/tokens.css", import.meta.url),
  "utf8"
);

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
});
