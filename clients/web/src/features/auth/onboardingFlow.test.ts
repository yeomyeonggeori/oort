import { describe, expect, it } from "vitest";
import {
  gatewayPrefillFocus,
  initialOnboarding,
  progressLabel,
  transitionFor,
  type OnboardingStep,
} from "./onboardingFlow";

describe("onboarding first step", () => {
  it("opens on the landing when nothing is stored", () => {
    expect(
      initialOnboarding({ hasStoredServer: false, hasInvitePrefill: false })
    ).toEqual({ step: "landing", path: null });
  });

  it("skips the landing when a server is already stored", () => {
    expect(
      initialOnboarding({ hasStoredServer: true, hasInvitePrefill: false })
    ).toEqual({ step: "gateway", path: "server" });
  });

  it("skips the landing onto the invite path when a join code arrived", () => {
    expect(
      initialOnboarding({ hasStoredServer: true, hasInvitePrefill: true })
    ).toEqual({ step: "gateway", path: "invite" });
  });
});

describe("gateway prefill focus", () => {
  it("lands on the first S1 field still empty, else the next button", () => {
    expect(
      gatewayPrefillFocus({
        serverUrl: "",
        inviteCode: "Ab3-_x",
        requiresServer: true,
        joinPath: true,
      })
    ).toBe("server");
    expect(
      gatewayPrefillFocus({
        serverUrl: "https://team.example.com",
        inviteCode: "",
        requiresServer: true,
        joinPath: true,
      })
    ).toBe("code");
    expect(
      gatewayPrefillFocus({
        serverUrl: "https://team.example.com",
        inviteCode: "Ab3-_x",
        requiresServer: true,
        joinPath: true,
      })
    ).toBe("next");
    expect(
      gatewayPrefillFocus({
        serverUrl: "",
        inviteCode: "",
        requiresServer: false,
        joinPath: false,
      })
    ).toBe("next");
  });
});

describe("onboarding progress", () => {
  it("hides the bar on the landing and counts 2/4 then 3/4 then 4/4", () => {
    expect(progressLabel("landing")).toBeNull();
    expect(progressLabel("gateway")).toBe("2/4");
    expect(progressLabel("account")).toBe("3/4");
    expect(progressLabel("profile" as OnboardingStep)).toBe("4/4");
  });
});

describe("onboarding transitions", () => {
  it("uses mask-reveal from the dark landing into the form", () => {
    expect(transitionFor("landing", "gateway", false)).toEqual({
      effect: "mask-reveal-down",
      direction: "forward",
    });
    expect(transitionFor("gateway", "landing", false)).toEqual({
      effect: "mask-reveal-up",
      direction: "backward",
    });
  });

  it("uses line-slide between gateway and account", () => {
    expect(transitionFor("gateway", "account", false)).toEqual({
      effect: "line-slide",
      direction: "forward",
    });
    expect(transitionFor("account", "gateway", false)).toEqual({
      effect: "line-slide",
      direction: "backward",
    });
  });

  it("uses line-slide from account into profile, and none when motion is reduced", () => {
    expect(
      transitionFor("account", "profile" as OnboardingStep, false)
    ).toEqual({
      effect: "line-slide",
      direction: "forward",
    });
    expect(
      transitionFor("account", "profile" as OnboardingStep, true)
    ).toEqual({
      effect: "none",
      direction: "forward",
    });
  });

  it("drops motion when the person asked for less of it", () => {
    expect(transitionFor("landing", "gateway", true).effect).toBe("none");
    expect(transitionFor("gateway", "account", true).effect).toBe("none");
  });
});
