// Join applyLogin persists the session before S3 finishes. App would otherwise
// see hasPersistedSession and enter `restoring`, unmounting ConnectPage.
// Measured: capture waitFor(onboarding-profile) timed out 30000ms after a
// createdMember join (CAPTURE_PORT=8641, 2026-09-05).

const listeners = new Set<() => void>();

let held = false;

function notify(): void {
  for (const listener of listeners) listener();
}

export function holdSessionRestore(): void {
  if (held) return;
  held = true;
  notify();
}

export function releaseSessionRestore(): void {
  if (!held) return;
  held = false;
  notify();
}

export function sessionRestoreHeld(): boolean {
  return held;
}

export function subscribeSessionRestoreHold(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}
