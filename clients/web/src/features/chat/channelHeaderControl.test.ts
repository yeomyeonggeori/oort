import { describe, expect, it } from "vitest";
import { channelHeaderControlClass } from "./channelHeaderControl";

describe("channelHeaderControlClass", () => {
  it("draws a 32px rounded square with a control border", () => {
    const className = channelHeaderControlClass();
    expect(className).toContain("size-control");
    expect(className).toContain("rounded-sm");
    expect(className).toContain("border-line-strong");
    expect(className).toContain("focus-visible:focus-ring");
  });

  it("widens for a count without leaving the control height", () => {
    const className = channelHeaderControlClass({ wide: true });
    expect(className).toContain("h-control");
    expect(className).not.toContain("size-control");
    expect(className).toContain("px-2");
  });

  it("keeps a pressed terminal on accent-soft, not a second fill", () => {
    const className = channelHeaderControlClass({ pressed: true });
    expect(className).toContain("bg-accent-soft");
    expect(className).toContain("text-accent");
  });
});
