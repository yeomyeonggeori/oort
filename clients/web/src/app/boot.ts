// =============================================================================
// Boot budgets (DESK-1) — nothing on the boot path may hold the screen.
//
// The measured symptom: the packaged desktop app showed a loading skeleton for
// ~30 seconds before the connect screen appeared. mDNS was the suspect and mDNS
// was innocent — `discovery_start` returns the instant it spawns its browse
// thread (clients/desktop/src-tauri/src/discovery.rs), and it is only ever
// called from ConnectPage's own effect, so it cannot precede the screen it feeds.
// The 30 000 ms in that file is a ceiling the 4 000 ms caller never reaches.
//
// The real path was two serial gates, neither of which had a deadline of its own:
//
//   1. `initSessionStore()` blocked the FIRST PAINT (main.tsx). In the desktop
//      shell that awaits up to two Keychain IPC round trips, and macOS answers a
//      keychain item written by a differently-signed build with a PASSWORD
//      DIALOG rather than an error. Until it settled the window was blank —
//      not even the skeleton.
//   2. `restoreSession()` then held the skeleton (app/session.tsx) for one
//      `/v1/auth/refresh` rotation bounded only by `REQUEST_TIMEOUT_MS`
//      (15 000 ms, packages/momo-core/src/lib/http.ts). Cross-origin from
//      `tauri://localhost` every request is preflighted, and the server answered
//      no preflight at all (405 — the CORS half of this ticket), so the webview
//      burned the deadline on the OPTIONS and again on the POST: 15 000 × 2 =
//      30 000 ms, which is exactly what was observed. Web is same-origin and
//      React Native does not preflight, which is exactly why only desktop hurt.
//
// The CORS fix removes the doubling. These budgets remove the WAIT — because a
// server that is merely slow, unreachable, or on a `.local` name the webview
// cannot resolve would otherwise still hold the screen for 15 seconds, and the
// connect screen is precisely the surface someone needs when that happens.
//
// The work is never cancelled, only un-blocked: a rotation that lands after its
// budget still signs the person in, and a keychain that answers late still
// resumes (lib/session.ts `notify()` → the store subscription in app/session.tsx).
// That is the rule this file exists to enforce — results appear when they
// arrive; they do not get to hold the screen while they do not exist yet.
// =============================================================================

const env = import.meta.env as Record<string, string | undefined>;

function budget(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * How long the first paint may wait for session storage to settle.
 *
 * Short: the only thing lost by rendering early is that a resuming desktop user
 * sees the connect screen for a moment before the keychain answers, and that is
 * strictly better than the blank window this replaces. Nothing is lost for good
 * — `hasPersistedSession()` is subscribed, not sampled once.
 */
export const SESSION_HYDRATE_BUDGET_MS = budget(
  env.VITE_MOMO_HYDRATE_BUDGET_MS,
  1_200
);

/**
 * How long the skeleton may wait for the resume rotation before the connect
 * screen takes over. Overridable at BUILD time only, and only so the boot gate
 * can prove it is able to detect a regression (`gates/gate-boot-budget.mjs`);
 * an unset build gets the shipped default, which is the shipped behaviour.
 */
export const BOOT_RESTORE_BUDGET_MS = budget(
  env.VITE_MOMO_BOOT_RESTORE_BUDGET_MS,
  2_500
);

/**
 * Resolve when `work` settles or when `budgetMs` elapses, whichever is first.
 *
 * Never rejects and never cancels: `work` keeps running, and a rejection it
 * produces later is swallowed here rather than becoming an unhandled rejection.
 * The caller gets one guarantee — that it will be released on time.
 */
export function releaseAfter(
  work: Promise<unknown>,
  budgetMs: number
): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, budgetMs);
    void work
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}
