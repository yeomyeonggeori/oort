// =============================================================================
// Post-claim owner onboarding pending marker (ADR-0185 §8).
//
// Session is already in localStorage at claim success. The value is the current
// stage (`workspace-profile` then `invite`). A reload during S1 must re-enter
// S1; after S1 it must re-enter S2 rather than the first-run ladder.
// sessionStorage survives a same-tab reload; this key is written next to the
// four first-run markers and cleared on S2 complete/skip.
// =============================================================================

import {
  isOwnerOnboardingStage,
  OWNER_ONBOARDING_MOUNTED,
  type OwnerOnboardingStage,
} from "@/features/auth/onboardingFlow";

const listeners = new Set<() => void>();

export const OWNER_ONBOARDING_KEY = "oort.onboarding.v1";
/** @deprecated S1 is first; prefer `readOwnerOnboardingStage`. */
export const OWNER_ONBOARDING_PENDING_STAGE = "invite";

function sessionStore(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeOwnerOnboarding(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function writeStage(stage: OwnerOnboardingStage): void {
  try {
    sessionStore()?.setItem(OWNER_ONBOARDING_KEY, stage);
  } catch {
    // Private mode can refuse sessionStorage; the stage then cannot resume.
  }
  notify();
}

export function markOwnerOnboardingPending(): void {
  writeStage(OWNER_ONBOARDING_MOUNTED[0] ?? "invite");
}

export function markOwnerOnboardingStage(stage: OwnerOnboardingStage): void {
  writeStage(stage);
}

export function readOwnerOnboardingStage(): OwnerOnboardingStage | null {
  try {
    const raw = sessionStore()?.getItem(OWNER_ONBOARDING_KEY);
    return isOwnerOnboardingStage(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function ownerOnboardingIsPending(): boolean {
  return readOwnerOnboardingStage() !== null;
}

export function clearOwnerOnboardingPending(): void {
  try {
    sessionStore()?.removeItem(OWNER_ONBOARDING_KEY);
  } catch {
    // same as mark
  }
  notify();
}
