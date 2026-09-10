// =============================================================================
// Post-claim owner onboarding pending marker (ADR-0185 §8).
//
// Session is already in localStorage at claim success. A reload during S2 must
// re-enter S2 rather than the first-run ladder. sessionStorage survives a
// same-tab reload; this key is written next to the four first-run markers and
// cleared on complete/skip.
// =============================================================================

const listeners = new Set<() => void>();

export const OWNER_ONBOARDING_KEY = "oort.onboarding.v1";
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

export function markOwnerOnboardingPending(): void {
  try {
    sessionStore()?.setItem(OWNER_ONBOARDING_KEY, OWNER_ONBOARDING_PENDING_STAGE);
  } catch {
    // Private mode can refuse sessionStorage; S2 then cannot resume after reload.
  }
  notify();
}

export function ownerOnboardingIsPending(): boolean {
  try {
    return sessionStore()?.getItem(OWNER_ONBOARDING_KEY) === OWNER_ONBOARDING_PENDING_STAGE;
  } catch {
    return false;
  }
}

export function clearOwnerOnboardingPending(): void {
  try {
    sessionStore()?.removeItem(OWNER_ONBOARDING_KEY);
  } catch {
    // same as mark
  }
  notify();
}
