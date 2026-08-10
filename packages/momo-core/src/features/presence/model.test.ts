import { describe, expect, it } from "vitest";
import { effectivePresence, isPresenceStatus } from "../../lib/api";
import {
  declaredStatusLabel,
  effectivePresenceLabel,
  presenceTriggerLabel,
  PRESENCE_OPTIONS,
} from "./model";

describe("effectivePresence (ADR-0160 D3)", () => {
  it("lets dnd win even while connected", () => {
    // 「지금 핑 금지」 is true whether or not the client is attached.
    expect(effectivePresence("dnd", true)).toBe("dnd");
    expect(effectivePresence("dnd", false)).toBe("dnd");
  });

  it("shows away regardless of availability", () => {
    expect(effectivePresence("away", true)).toBe("away");
    expect(effectivePresence("away", false)).toBe("away");
  });

  it("resolves auto by availability", () => {
    expect(effectivePresence("auto", true)).toBe("online");
    expect(effectivePresence("auto", false)).toBe("offline");
  });

  it("falls back to availability alone when no status is declared", () => {
    // A server too old to carry the column, or a member with none.
    expect(effectivePresence(undefined, true)).toBe("online");
    expect(effectivePresence(undefined, false)).toBe("offline");
  });
});

describe("presence copy", () => {
  it("offers the three declared statuses in order, auto worded as online", () => {
    expect(PRESENCE_OPTIONS.map((option) => option.status)).toEqual([
      "auto",
      "away",
      "dnd",
    ]);
    expect(PRESENCE_OPTIONS[0]?.label).toBe("온라인");
  });

  it("names every declared and effective value", () => {
    expect(declaredStatusLabel("dnd")).toBe("방해 금지");
    expect(effectivePresenceLabel("offline")).toBe("오프라인");
    expect(effectivePresenceLabel("online")).toBe("온라인");
    expect(presenceTriggerLabel("dnd")).toContain("방해 금지");
    expect(presenceTriggerLabel("dnd")).toContain("변경");
  });
});

describe("isPresenceStatus", () => {
  it("accepts only the three enum labels", () => {
    for (const status of ["auto", "away", "dnd"]) {
      expect(isPresenceStatus(status)).toBe(true);
    }
    for (const bad of ["active", "online", "offline", "busy", "", null, 3]) {
      expect(isPresenceStatus(bad)).toBe(false);
    }
  });
});
