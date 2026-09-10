// S1 typed draft. sessionStorage so a same-tab reload keeps the three
// fields (N-6). Private mode / quota: the form starts empty.
//
// Re-offer (H-R3-1): seed from the current member/workspace. Prefer the draft
// only for fields that have not been saved in settings.

import {
  defaultWorkspaceName,
  suggestedHandle,
} from "./fallbackHandle";
import { SEED_HANDLE } from "./s1Copy";

const SLOT = "oort.onboarding.s1.draft.v1";

export type S1Draft = {
  workspaceName: string;
  displayName: string;
  handle: string;
};

function store(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function isDraft(value: unknown): value is S1Draft {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.workspaceName === "string" &&
    typeof candidate.displayName === "string" &&
    typeof candidate.handle === "string"
  );
}

export function readS1Draft(): S1Draft | null {
  const raw = store()?.getItem(SLOT);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isDraft(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeS1Draft(draft: S1Draft): void {
  try {
    store()?.setItem(SLOT, JSON.stringify(draft));
  } catch {
    // Quota or a read-only store: a reload starts empty.
  }
}

export function clearS1Draft(): void {
  try {
    store()?.removeItem(SLOT);
  } catch {
    // same as write
  }
}

export function clearS1DraftFields(keys: (keyof S1Draft)[]): void {
  const current = readS1Draft();
  if (!current) return;
  const next: S1Draft = { ...current };
  for (const key of keys) next[key] = "";
  if (!next.workspaceName && !next.displayName && !next.handle) {
    clearS1Draft();
    return;
  }
  writeS1Draft(next);
}

export function resolveS1Seeds(input: {
  draft: S1Draft | null;
  workspaceName?: string;
  memberHandle: string;
  memberDisplayName?: string;
  email?: string;
  profileSaved: boolean;
  workspaceSaved: boolean;
}): S1Draft {
  const workspaceName = input.workspaceSaved
    ? defaultWorkspaceName(input.workspaceName)
    : (input.draft?.workspaceName ?? defaultWorkspaceName(input.workspaceName));
  const displayName = input.profileSaved
    ? (input.memberDisplayName ?? "")
    : (input.draft?.displayName ?? "");
  const handle = input.profileSaved
    ? (input.memberHandle === SEED_HANDLE ? "" : input.memberHandle)
    : (input.draft?.handle ?? suggestedHandle(input.email ?? input.memberHandle));
  return { workspaceName, displayName, handle };
}
