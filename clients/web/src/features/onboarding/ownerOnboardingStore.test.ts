// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  clearOwnerOnboardingPending,
  markOwnerOnboardingPending,
  markOwnerOnboardingStage,
  ownerOnboardingIsPending,
  OWNER_ONBOARDING_KEY,
  readOwnerOnboardingStage,
} from "./ownerOnboardingStore";

afterEach(() => {
  clearOwnerOnboardingPending();
});

describe("owner onboarding pending marker", () => {
  it("starts on S1 and advances to S2 without clearing", () => {
    expect(ownerOnboardingIsPending()).toBe(false);
    markOwnerOnboardingPending();
    expect(ownerOnboardingIsPending()).toBe(true);
    expect(readOwnerOnboardingStage()).toBe("workspace-profile");
    expect(sessionStorage.getItem(OWNER_ONBOARDING_KEY)).toBe("workspace-profile");
    markOwnerOnboardingStage("invite");
    expect(ownerOnboardingIsPending()).toBe(true);
    expect(readOwnerOnboardingStage()).toBe("invite");
    clearOwnerOnboardingPending();
    expect(ownerOnboardingIsPending()).toBe(false);
    expect(readOwnerOnboardingStage()).toBeNull();
  });
});
