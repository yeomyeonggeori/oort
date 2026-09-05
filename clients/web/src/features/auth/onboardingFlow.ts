export type OnboardingStep = "landing" | "gateway" | "account" | "profile";
export type OnboardingPath = "server" | "invite";
export type OnboardingTransitionDirection = "forward" | "backward";
export type OnboardingTransitionEffect =
  | "fade"
  | "line-slide"
  | "mask-reveal-down"
  | "mask-reveal-up"
  | "none";

const STEP_ORDER: Record<OnboardingStep, number> = {
  landing: 0,
  gateway: 1,
  account: 2,
  profile: 3,
};

/**
 * First paint. A stored server or an invite prefill means the person already
 * chose a path, so S0 stays off. Invite wins when both are present: the link
 * is why they opened the client.
 */
export function initialOnboarding(input: {
  hasStoredServer: boolean;
  hasInvitePrefill: boolean;
}): { step: OnboardingStep; path: OnboardingPath | null } {
  if (input.hasInvitePrefill) return { step: "gateway", path: "invite" };
  if (input.hasStoredServer) return { step: "gateway", path: "server" };
  return { step: "landing", path: null };
}

export function progressLabel(step: OnboardingStep): string | null {
  if (step === "gateway") return "2/4";
  if (step === "account") return "3/4";
  if (step === "profile") return "4/4";
  return null;
}

/**
 * Where S1 should land the cursor after a deep link (or any prefill that
 * opened the gateway). Email/password live on S2, so the old single-form
 * `prefillFocus` returning those fields is a silent no-op here.
 */
export function gatewayPrefillFocus(form: {
  serverUrl: string;
  inviteCode: string;
  requiresServer: boolean;
  joinPath: boolean;
}): "server" | "code" | "next" {
  if (form.requiresServer && form.serverUrl.trim() === "") return "server";
  if (form.joinPath && form.inviteCode.trim() === "") return "code";
  return "next";
}

export function transitionFor(
  from: OnboardingStep,
  to: OnboardingStep,
  reducedMotion: boolean
): {
  effect: OnboardingTransitionEffect;
  direction: OnboardingTransitionDirection;
} {
  if (reducedMotion || from === to) {
    return { effect: "none", direction: "forward" };
  }
  const direction: OnboardingTransitionDirection =
    STEP_ORDER[to] >= STEP_ORDER[from] ? "forward" : "backward";
  const crossingLanding =
    (from === "landing" && to === "gateway") ||
    (from === "gateway" && to === "landing");
  if (crossingLanding) {
    return {
      effect: direction === "forward" ? "mask-reveal-down" : "mask-reveal-up",
      direction,
    };
  }
  return { effect: "line-slide", direction };
}
