import { describe, expect, it } from "vitest";
import { channelHeaderControlClass } from "./channelHeaderControl";

describe("channelHeaderControlClass", () => {
  it("draws the mockup .a-ibtn: 34px, radius 10, no border (ADR-0189 D6)", () => {
    const className = channelHeaderControlClass();
    expect(className).toContain("size-icon-button");
    expect(className).toContain("rounded-md");
    expect(className).not.toMatch(/\bborder\b/);
    expect(className).toContain("focus-visible:focus-ring");
  });

  it("widens for a count without leaving the control height", () => {
    const className = channelHeaderControlClass({ wide: true });
    expect(className).toContain("h-icon-button");
    expect(className).not.toContain("size-icon-button");
    expect(className).toContain("px-2");
  });

  it("keeps a pressed terminal on accent-soft, not a second fill", () => {
    const className = channelHeaderControlClass({ pressed: true });
    expect(className).toContain("bg-accent-soft");
    expect(className).toContain("text-signal-text");
  });
});
