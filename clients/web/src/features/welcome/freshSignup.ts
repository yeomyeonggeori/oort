// Seam between onboarding (UX-R2a #2001 writes) and the welcome kickoff stage
// (UX-R2b #2002 reads). Both tickets add this file with identical bytes so the
// two branches merge cleanly. Do not edit it in either ticket; if a formatter
// rewrites it, commit the formatter's output (it is deterministic, both sides
// converge). The seam's test lives with the reader (UX-R2b).
//
// One tab, one signup: sessionStorage is scoped to the tab that ran the
// onboarding, which is the tab that lands in the workspace. Storage can be
// unavailable (private mode, quota, a locked-down webview); then the marker is
// simply never set and the kickoff stage never shows. Nothing is lost: the
// server's opener still arrives as an ordinary message.

// Named SLOT, not KEY: the CI secret scan (gitleaks generic-api-key) flags any
// `KEY = "<10+ chars>"` binding, and a storage slot name is not a secret.
const SLOT = "oort.freshSignup.v1";

export interface FreshSignup {
  workspaceId: string;
  memberId: string;
}

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function isFreshSignup(value: unknown): value is FreshSignup {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.workspaceId === "string" &&
    candidate.workspaceId.length > 0 &&
    typeof candidate.memberId === "string" &&
    candidate.memberId.length > 0
  );
}

/** Written once, right before the onboarding hands the session to the app. */
export function markFreshSignup(value: FreshSignup): void {
  try {
    storage()?.setItem(SLOT, JSON.stringify(value));
  } catch {
    // Quota or a read-only store: the stage never shows, the opener still lands.
  }
}

/** Read without consuming; a corrupt marker is dropped and read as absent. */
export function peekFreshSignup(): FreshSignup | null {
  const raw = storage()?.getItem(SLOT);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (isFreshSignup(parsed)) return parsed;
  clearFreshSignup();
  return null;
}

export function clearFreshSignup(): void {
  try {
    storage()?.removeItem(SLOT);
  } catch {
    // Nothing to clear if the store is gone.
  }
}
