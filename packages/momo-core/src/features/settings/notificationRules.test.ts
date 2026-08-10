import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_RULES,
  notificationRulesFromWire,
} from "./notificationRules";

describe("notificationRulesFromWire", () => {
  it("reads both switches from a well-formed body", () => {
    expect(
      notificationRulesFromWire({ dnd: true, mentionOverridesMute: false })
    ).toEqual({ dnd: true, mentionOverridesMute: false });
  });

  it("treats a missing switch as off, the pre-증보 default", () => {
    // A server that never wrote a row answers with the defaults; a switch that
    // is simply absent must read false, never undefined.
    expect(notificationRulesFromWire({})).toEqual(DEFAULT_NOTIFICATION_RULES);
    expect(notificationRulesFromWire({ dnd: true })).toEqual({
      dnd: true,
      mentionOverridesMute: false,
    });
  });

  it("degrades a non-object body to defaults instead of throwing", () => {
    // The route is new; a proxy answering 200 with a string must not crash the
    // panel (the chainModel lesson). "both off" is the honest, safe fallback.
    expect(notificationRulesFromWire("not json")).toEqual(
      DEFAULT_NOTIFICATION_RULES
    );
    expect(notificationRulesFromWire(null)).toEqual(DEFAULT_NOTIFICATION_RULES);
  });

  it("ignores a non-boolean switch rather than coercing it", () => {
    expect(
      notificationRulesFromWire({ dnd: "yes", mentionOverridesMute: 1 })
    ).toEqual(DEFAULT_NOTIFICATION_RULES);
  });
});
