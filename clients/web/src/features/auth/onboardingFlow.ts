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
 * Post-claim zero-base stages (ADR-0185 D-A (3), SH-12b-w / SH-12c).
 *
 * Order is the table. Counter text is derived from it, so S1 is `1/2` and
 * S2 is `2/2` while this list has two slots. Claim password is not a step.
 * Inserting a stage means adding it here; S2 does not fork.
 */
export const OWNER_ONBOARDING_STAGES = [
  "workspace-profile",
  "invite",
] as const;

export type OwnerOnboardingStage = (typeof OWNER_ONBOARDING_STAGES)[number];

/** Stages this checkout actually mounts. Claim → S1 (required) → S2 (skip). */
export const OWNER_ONBOARDING_MOUNTED: readonly OwnerOnboardingStage[] = [
  "workspace-profile",
  "invite",
];

export function isOwnerOnboardingStage(
  value: string | null | undefined
): value is OwnerOnboardingStage {
  return value === "workspace-profile" || value === "invite";
}

export function ownerOnboardingTotalSteps(): number {
  return OWNER_ONBOARDING_STAGES.length;
}

export function ownerOnboardingProgressLabel(
  stage: OwnerOnboardingStage
): string {
  const index = OWNER_ONBOARDING_STAGES.indexOf(stage);
  return `${index + 1}/${OWNER_ONBOARDING_STAGES.length}`;
}

export function resolveOwnerOnboardingStage(
  pending: string | null | undefined
): OwnerOnboardingStage {
  if (
    isOwnerOnboardingStage(pending) &&
    OWNER_ONBOARDING_MOUNTED.includes(pending)
  ) {
    return pending;
  }
  return OWNER_ONBOARDING_MOUNTED[0] ?? "invite";
}

export function nextOwnerOnboardingStage(
  current: OwnerOnboardingStage
): OwnerOnboardingStage | null {
  const index = OWNER_ONBOARDING_MOUNTED.indexOf(current);
  if (index < 0) return OWNER_ONBOARDING_MOUNTED[0] ?? null;
  return OWNER_ONBOARDING_MOUNTED[index + 1] ?? null;
}

export function initialOwnerOnboardingStage(): OwnerOnboardingStage {
  return resolveOwnerOnboardingStage(null);
}

/** ADR-0185 §8 sealed S2 defaults: TTL 24h, uses 1, re-issuable in settings. */
export const OWNER_INVITE_TTL_MS = 86_400_000;
export const OWNER_INVITE_MAX_USES = 1;
export const OWNER_INVITE_ROLE = "member";

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
