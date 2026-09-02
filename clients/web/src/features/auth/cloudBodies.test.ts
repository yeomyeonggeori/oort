import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CENTRE_RADIUS,
  CLOUD_BODIES,
  isInCtaBand,
  isInCtaExclusion,
  isInEmptyCentre,
} from "./cloudBodies";

const css = readFileSync(
  fileURLToPath(new URL("../../design/tokens.css", import.meta.url)),
  "utf8"
);

describe("Oort cloud scatter", () => {
  it("places thirty line-art bodies on the outer shell", () => {
    expect(CLOUD_BODIES).toHaveLength(30);
    expect(CENTRE_RADIUS).toBeGreaterThanOrEqual(32);
    expect(CLOUD_BODIES.filter(isInEmptyCentre)).toEqual([]);
  });

  it("keeps rest poses out of the CTA band and the wander+repel pad", () => {
    expect(CLOUD_BODIES.filter(isInCtaBand)).toEqual([]);
    expect(CLOUD_BODIES.filter(isInCtaExclusion)).toEqual([]);
  });

  it("keeps size in the 22-36 band and uses three kinds in two tones", () => {
    const kinds = new Set(CLOUD_BODIES.map((body) => body.kind));
    const tones = new Set(CLOUD_BODIES.map((body) => body.tone));
    expect(kinds).toEqual(new Set(["comet", "asteroid", "star"]));
    expect(tones).toEqual(new Set(["accent", "ink"]));
    for (const body of CLOUD_BODIES) {
      expect(body.size).toBeGreaterThanOrEqual(22);
      expect(body.size).toBeLessThanOrEqual(36);
    }
  });

  it("repeats the same placement as CSS custom properties", () => {
    for (const body of CLOUD_BODIES) {
      const block = css.match(
        new RegExp(
          String.raw`\[data-onboarding-body="${body.index}"\]\s*\{[^}]+\}`
        )
      )?.[0];
      expect(block, `body ${body.index}`).toBeTruthy();
      expect(block).toContain(`--onboarding-body-top: ${body.top}%;`);
      expect(block).toContain(`--onboarding-body-left: ${body.left}%;`);
      expect(block).toContain(`--onboarding-body-size: ${body.size}px;`);
      expect(block).toContain(`--onboarding-body-rotate: ${body.rotate}deg;`);
    }
  });
});
