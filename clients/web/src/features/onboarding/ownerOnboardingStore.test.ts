// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  clearOwnerOnboardingFlag,
  clearOwnerOnboardingPending,
  finishOwnerOnboardingInvite,
  hasOwnerOnboardingFlag,
  hasOwnerOnboardingSettingsDoor,
  markOwnerOnboardingPending,
  markOwnerOnboardingStage,
  ownerOnboardingIsPending,
  ownerOnboardingShouldMount,
  OWNER_ONBOARDING_KEY,
  readOwnerOnboardingStage,
  recordOwnerOnboardingSettingsSave,
  resetOwnerOnboardingLoadState,
} from "./ownerOnboardingStore";
import { readS1Draft, writeS1Draft } from "./s1Draft";

afterEach(() => {
  clearOwnerOnboardingPending();
});

describe("owner onboarding pending flags", () => {
  it("starts with both flags and advances S1 without clearing invite", () => {
    expect(ownerOnboardingIsPending()).toBe(false);
    markOwnerOnboardingPending();
    expect(ownerOnboardingIsPending()).toBe(true);
    expect(readOwnerOnboardingStage()).toBe("workspace-profile");
    expect(hasOwnerOnboardingFlag("workspace-profile")).toBe(true);
    expect(hasOwnerOnboardingFlag("invite")).toBe(true);
    expect(sessionStorage.getItem(OWNER_ONBOARDING_KEY)).toBe(
      JSON.stringify({ "workspace-profile": true, invite: true })
    );
    markOwnerOnboardingStage("invite");
    expect(ownerOnboardingIsPending()).toBe(true);
    expect(readOwnerOnboardingStage()).toBe("invite");
    expect(hasOwnerOnboardingFlag("workspace-profile")).toBe(false);
    expect(hasOwnerOnboardingFlag("invite")).toBe(true);
    finishOwnerOnboardingInvite();
    expect(hasOwnerOnboardingFlag("invite")).toBe(false);
    expect(ownerOnboardingIsPending()).toBe(false);
    expect(readOwnerOnboardingStage()).toBeNull();
  });

  it("S2 finish clears only invite so a skipped S1 remains", () => {
    markOwnerOnboardingPending();
    finishOwnerOnboardingInvite();
    expect(hasOwnerOnboardingFlag("invite")).toBe(false);
    expect(hasOwnerOnboardingFlag("workspace-profile")).toBe(true);
    expect(readOwnerOnboardingStage()).toBe("workspace-profile");
    expect(ownerOnboardingShouldMount()).toBe(false);
    resetOwnerOnboardingLoadState();
    expect(ownerOnboardingShouldMount()).toBe(true);
  });

  it("legacy string values still resume the matching stage", () => {
    sessionStorage.setItem(OWNER_ONBOARDING_KEY, "invite");
    expect(readOwnerOnboardingStage()).toBe("invite");
    expect(hasOwnerOnboardingFlag("invite")).toBe(true);
    expect(hasOwnerOnboardingFlag("workspace-profile")).toBe(false);
  });

  it("clears workspace-profile only after both settings doors succeed", () => {
    markOwnerOnboardingPending();
    clearOwnerOnboardingFlag("invite");
    recordOwnerOnboardingSettingsSave("workspace");
    expect(hasOwnerOnboardingFlag("workspace-profile")).toBe(true);
    expect(hasOwnerOnboardingSettingsDoor("workspace")).toBe(true);
    recordOwnerOnboardingSettingsSave("profile");
    expect(hasOwnerOnboardingFlag("workspace-profile")).toBe(false);
  });

  it("does not write settings flags when onboarding is not pending (N-R3-2)", () => {
    recordOwnerOnboardingSettingsSave("profile");
    expect(sessionStorage.getItem(OWNER_ONBOARDING_KEY)).toBeNull();
    expect(hasOwnerOnboardingSettingsDoor("profile")).toBe(false);
  });

  it("settings save clears the matching S1 draft fields (H-R3-1)", () => {
    markOwnerOnboardingPending();
    writeS1Draft({
      workspaceName: "여명거리",
      displayName: "곽성재",
      handle: "seongjae",
    });
    recordOwnerOnboardingSettingsSave("profile");
    expect(readS1Draft()).toEqual({
      workspaceName: "여명거리",
      displayName: "",
      handle: "",
    });
    recordOwnerOnboardingSettingsSave("workspace");
    expect(readS1Draft()).toBeNull();
    expect(hasOwnerOnboardingFlag("workspace-profile")).toBe(false);
  });
});
