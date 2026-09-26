import { describe, expect, it } from "vitest";
import {
  initialOnboarding,
  initialOwnerOnboardingStage,
  nextOwnerOnboardingStage,
  ownerOnboardingProgressLabel,
  ownerOnboardingTotalSteps,
  OWNER_ONBOARDING_MOUNTED,
  OWNER_ONBOARDING_STAGES,
  resolveOwnerOnboardingStage,
  transitionFor,
} from "./onboardingFlow";

describe("onboarding first step (ADR-0193 D7)", () => {
  it("opens on D0 when nothing is stored and no link opened the window", () => {
    expect(
      initialOnboarding({ hasStoredServer: false, hasInvitePrefill: false })
    ).toBe("welcome");
  });

  it("skips D0 onto D1 when a server is already stored", () => {
    expect(
      initialOnboarding({ hasStoredServer: true, hasInvitePrefill: false })
    ).toBe("sign-in");
  });

  it("skips D0 onto D1′ when an invite link opened the window, stored server or not", () => {
    expect(
      initialOnboarding({ hasStoredServer: true, hasInvitePrefill: true })
    ).toBe("join");
    expect(
      initialOnboarding({ hasStoredServer: false, hasInvitePrefill: true })
    ).toBe("join");
  });
});

describe("owner onboarding stages (ADR-0185)", () => {
  it("totalSteps_is_2", () => {
    expect(ownerOnboardingTotalSteps()).toBe(2);
    expect(OWNER_ONBOARDING_STAGES).toHaveLength(2);
    expect(OWNER_ONBOARDING_STAGES).toEqual(["workspace-profile", "invite"]);
    expect(ownerOnboardingProgressLabel("workspace-profile")).toBe("1/2");
    expect(ownerOnboardingProgressLabel("invite")).toBe("2/2");
    expect(initialOwnerOnboardingStage()).toBe("workspace-profile");
    expect(OWNER_ONBOARDING_MOUNTED[0]).toBe("workspace-profile");
    expect(resolveOwnerOnboardingStage(null)).toBe("workspace-profile");
    expect(resolveOwnerOnboardingStage("invite")).toBe("invite");
    expect(nextOwnerOnboardingStage("workspace-profile")).toBe("invite");
    expect(nextOwnerOnboardingStage("invite")).toBeNull();
  });
});

describe("onboarding transitions (ADR-0193 D11)", () => {
  it("uses mask-reveal out of D0 and back into it", () => {
    expect(transitionFor("welcome", "sign-in", false)).toEqual({
      effect: "mask-reveal-down",
      direction: "forward",
    });
    expect(transitionFor("welcome", "join", false)).toEqual({
      effect: "mask-reveal-down",
      direction: "forward",
    });
    expect(transitionFor("sign-in", "welcome", false)).toEqual({
      effect: "mask-reveal-up",
      direction: "backward",
    });
  });

  it("uses line-slide between D1 and D1′", () => {
    expect(transitionFor("join", "sign-in", false).effect).toBe("line-slide");
    expect(transitionFor("sign-in", "join", false).effect).toBe("line-slide");
  });

  it("drops motion when the person asked for less of it, and on a no-op move", () => {
    expect(transitionFor("welcome", "sign-in", true).effect).toBe("none");
    expect(transitionFor("sign-in", "join", true).effect).toBe("none");
    expect(transitionFor("join", "join", false).effect).toBe("none");
  });
});
