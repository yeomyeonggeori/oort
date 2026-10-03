import { describe, expect, it } from "vitest";
import { composerRoutingSlot } from "./composerRoutingSlot";

describe("composerRoutingSlot", () => {
  it("lets the warning take the slot itself when no called agent answers (no empty band)", () => {
    expect(composerRoutingSlot({ hasTarget: true, noneAnswer: true, rowReserved: true, hasNotice: true })).toBe("warning");
  });
  it("keeps the routing bar for agents that answer, and the reserved band only when nothing is called", () => {
    expect(composerRoutingSlot({ hasTarget: true, noneAnswer: false, rowReserved: true, hasNotice: false })).toBe("bar");
    expect(composerRoutingSlot({ hasTarget: false, noneAnswer: false, rowReserved: true, hasNotice: false })).toBe("reserved");
    expect(composerRoutingSlot({ hasTarget: false, noneAnswer: false, rowReserved: false, hasNotice: false })).toBe("none");
  });
});
