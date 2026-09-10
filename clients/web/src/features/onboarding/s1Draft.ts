// S1 typed draft. sessionStorage so a same-tab reload keeps the three
// fields (N-6). Private mode / quota: the form starts empty.

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
