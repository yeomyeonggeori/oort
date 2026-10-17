import { describe, expect, it } from "vitest";
import { effectivePresence, isPresenceStatus } from "../../lib/api";
import {
  declaredStatusLabel,
  effectivePresenceLabel,
  otherMemberDeclaredPresenceLabel,
  presenceTriggerLabel,
  PRESENCE_DND_HINT,
  PRESENCE_MENU_LABEL,
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
    expect(PRESENCE_OPTIONS).toEqual(["auto", "away", "dnd"]);
    expect(declaredStatusLabel(PRESENCE_OPTIONS[0]!)).toBe("온라인");
  });

  // design-review M2: the option list carries statuses and nothing else. A
  // `label` field here would be a second source for a word `declaredStatusLabel`
  // already owns, and the two drift while every test stays green — because the
  // tests would read the same stale field the menu does.
  it("keeps no label strings of its own on the option list", () => {
    for (const option of PRESENCE_OPTIONS) {
      expect(typeof option).toBe("string");
      expect(declaredStatusLabel(option).length).toBeGreaterThan(0);
    }
  });

  it("names every declared and effective value", () => {
    expect(declaredStatusLabel("dnd")).toBe("방해 금지");
    expect(effectivePresenceLabel("offline")).toBe("오프라인");
    expect(effectivePresenceLabel("online")).toBe("온라인");
    expect(presenceTriggerLabel("dnd")).toContain("방해 금지");
    expect(presenceTriggerLabel("dnd")).toContain("변경");
  });

  // The menu's visible title and the trigger's accessible name are the same
  // name, so they are one string. Reword one of them by hand and this goes red
  // instead of shipping a panel titled one thing and announced as another.
  it("opens the trigger's name with the menu's own title", () => {
    expect(presenceTriggerLabel("away").startsWith(PRESENCE_MENU_LABEL)).toBe(
      true
    );
  });

  it("does not name auto as 온라인 on someone else's profile", () => {
    expect(otherMemberDeclaredPresenceLabel("auto")).toBeNull();
    expect(otherMemberDeclaredPresenceLabel(undefined)).toBeNull();
    expect(otherMemberDeclaredPresenceLabel("away")).toBe("자리 비움");
    expect(otherMemberDeclaredPresenceLabel("dnd")).toBe("방해 금지");
  });
});

// ADR-0124 증보 2 「묶어」: 방해 금지를 고르면 서버가 알림 일시 중지도 함께 켠다. 처음 문장은
// 「알림은 「알림 일시 중지」가 멈춥니다」여서 정반대를 말했고, 그 문장을 읽은 사람이 알림이
// 15일 동안 멈춘 것을 화면에서 알 수 없었다(ADR-0204 맥락, #2899).
describe("PRESENCE_DND_HINT (ADR-0124 증보 2)", () => {
  it("says the alerts stop together with the status", () => {
    expect(PRESENCE_DND_HINT).toContain("알림도 함께 멈춰요");
  });

  it("no longer sends the reader to the pause switch for the alerts", () => {
    expect(PRESENCE_DND_HINT).not.toContain("알림 일시 중지");
    expect(PRESENCE_DND_HINT).not.toContain("멈춥니다");
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
