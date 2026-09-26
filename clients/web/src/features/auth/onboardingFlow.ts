/**
 * 로그인 전 온보딩 화면 (ADR-0193 D7, #2808·#2809·#2810).
 *
 *   welcome  D0  「어디로 갈까요?」 한 칸 + 발견·최근 서버 줄. 점 없음
 *   sign-in  D1  서버 칩 + 이메일 + 비밀번호. 필수 입력 화면 1
 *   join     D1′ 링크가 채운 서버·코드 + 이메일 + 새 비밀번호 + 표시 이름. 1
 *
 * 옛 S0(landing)·S1(gateway)·S2(account)·S3(profile) 네 화면이 이 셋이 됐다.
 * claim(D1″)은 실경로 `/claim/<token>`이라 여기 없다(#2811).
 */
export type OnboardingStep = "welcome" | "sign-in" | "join";
export type OnboardingTransitionDirection = "forward" | "backward";
export type OnboardingTransitionEffect =
  | "fade"
  | "line-slide"
  | "mask-reveal-down"
  | "mask-reveal-up"
  | "none";

const STEP_ORDER: Record<OnboardingStep, number> = {
  welcome: 0,
  "sign-in": 1,
  join: 1,
};

/**
 * 첫 그림. 링크로 열렸거나 저장된 서버가 있으면 D0을 건너뛴다(ADR-0193 D7).
 * 둘 다면 초대가 이긴다: 그 링크가 이 창을 연 이유다.
 */
export function initialOnboarding(input: {
  hasStoredServer: boolean;
  hasInvitePrefill: boolean;
}): OnboardingStep {
  if (input.hasInvitePrefill) return "join";
  if (input.hasStoredServer) return "sign-in";
  return "welcome";
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
  // D0에서 다음 화면으로, 또는 돌아올 때는 mask-reveal(D11). D1 ↔ D1′은 line-slide.
  const crossingWelcome = from === "welcome" || to === "welcome";
  if (crossingWelcome) {
    return {
      effect: direction === "forward" ? "mask-reveal-down" : "mask-reveal-up",
      direction,
    };
  }
  return { effect: "line-slide", direction };
}
