// =============================================================================
// Post-claim owner onboarding pending flags (ADR-0185 §8, R3).
//
// Session is already in localStorage at claim success. The key holds TWO
// independent flags: `workspace-profile` (S1) and `invite` (S2). A reload
// during S1 must re-enter S1; after S1 it must re-enter S2 rather than the
// first-run ladder. S2 complete/skip clears ONLY `invite`. `workspace-profile`
// is cleared by S1 completion (both saves OK) or by both settings doors
// succeeding later. sessionStorage survives a same-tab reload; a JS-heap
// dismiss covers "this load, go to the shell" without dropping S1's re-offer.
// =============================================================================

import {
  isOwnerOnboardingStage,
  type OwnerOnboardingStage,
} from "@/features/auth/onboardingFlow";

const listeners = new Set<() => void>();

export const OWNER_ONBOARDING_KEY = "oort.onboarding.v1";

type PendingDoc = {
  "workspace-profile"?: boolean;
  invite?: boolean;
  "settings-workspace"?: boolean;
  "settings-profile"?: boolean;
};

let dismissedThisLoad = false;

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

function readDoc(): PendingDoc {
  try {
    const raw = sessionStore()?.getItem(OWNER_ONBOARDING_KEY);
    if (!raw) return {};
    if (isOwnerOnboardingStage(raw)) return { [raw]: true };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const record = parsed as Record<string, unknown>;
    const doc: PendingDoc = {};
    if (record["workspace-profile"] === true) doc["workspace-profile"] = true;
    if (record.invite === true) doc.invite = true;
    if (record["settings-workspace"] === true) doc["settings-workspace"] = true;
    if (record["settings-profile"] === true) doc["settings-profile"] = true;
    return doc;
  } catch {
    return {};
  }
}

function writeDoc(doc: PendingDoc): void {
  const next: PendingDoc = {};
  if (doc["workspace-profile"]) next["workspace-profile"] = true;
  if (doc.invite) next.invite = true;
  if (doc["settings-workspace"]) next["settings-workspace"] = true;
  if (doc["settings-profile"]) next["settings-profile"] = true;
  try {
    if (Object.keys(next).length === 0) {
      sessionStore()?.removeItem(OWNER_ONBOARDING_KEY);
    } else {
      sessionStore()?.setItem(OWNER_ONBOARDING_KEY, JSON.stringify(next));
    }
  } catch {
    // Private mode can refuse sessionStorage; the stage then cannot resume.
  }
  notify();
}

export function markOwnerOnboardingPending(): void {
  dismissedThisLoad = false;
  writeDoc({
    "workspace-profile": true,
    invite: true,
  });
}

export function markOwnerOnboardingStage(stage: OwnerOnboardingStage): void {
  const doc = readDoc();
  if (stage === "invite") {
    doc["workspace-profile"] = false;
    doc.invite = true;
  } else {
    doc["workspace-profile"] = true;
  }
  writeDoc(doc);
}

export function hasOwnerOnboardingFlag(flag: OwnerOnboardingStage): boolean {
  const doc = readDoc();
  return flag === "invite" ? doc.invite === true : doc["workspace-profile"] === true;
}

export function clearOwnerOnboardingFlag(flag: OwnerOnboardingStage): void {
  const doc = readDoc();
  if (flag === "invite") doc.invite = false;
  else doc["workspace-profile"] = false;
  writeDoc(doc);
}

export function readOwnerOnboardingStage(): OwnerOnboardingStage | null {
  const doc = readDoc();
  if (doc["workspace-profile"]) return "workspace-profile";
  if (doc.invite) return "invite";
  return null;
}

export function ownerOnboardingIsPending(): boolean {
  return readOwnerOnboardingStage() !== null;
}

export function ownerOnboardingShouldMount(): boolean {
  return !dismissedThisLoad && ownerOnboardingIsPending();
}

export function dismissOwnerOnboardingThisLoad(): void {
  dismissedThisLoad = true;
  notify();
}

export function finishOwnerOnboardingInvite(): void {
  clearOwnerOnboardingFlag("invite");
  dismissOwnerOnboardingThisLoad();
}

export function recordOwnerOnboardingSettingsSave(
  door: "workspace" | "profile"
): void {
  const doc = readDoc();
  if (door === "workspace") doc["settings-workspace"] = true;
  else doc["settings-profile"] = true;
  if (doc["settings-workspace"] && doc["settings-profile"]) {
    doc["workspace-profile"] = false;
  }
  writeDoc(doc);
}

export function clearOwnerOnboardingPending(): void {
  dismissedThisLoad = false;
  try {
    sessionStore()?.removeItem(OWNER_ONBOARDING_KEY);
  } catch {
    // same as mark
  }
  notify();
}

export function resetOwnerOnboardingLoadState(): void {
  dismissedThisLoad = false;
  notify();
}
