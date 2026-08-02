import type {Member} from '@momo/core/lib/api';

// =============================================================================
// "인증 전인가 후인가", as a pure function of three facts.
//
// This is separated from the hook that feeds it (`useAuthGate`) because the
// decision is the part that can be wrong in a way a person notices, and it is
// exactly the part a React test makes expensive to reach. The three failure
// modes it exists to prevent, all of which this codebase has notes about:
//
//   1. **signing a signed-in person out.** A stored session hydrates its member
//      from MMKV instantly, but the access token is memory-only by design
//      (ADR-0137 D7) — so between launch and the first refresh rotation there is
//      a member with no token. Reading that as "signed out" drops someone on a
//      login form they do not need. It reads as `restoring`.
//   2. **showing the shell before it can make a request.** The mirror of (1):
//      a member without a token would render a sidebar whose every query 401s.
//   3. **saying nothing when the session ends.** `markAuthExpired` is set when a
//      401 survived a rotation attempt — the session is over, not slow. Landing
//      on a blank sign-in form with no explanation reads as a bug in the app.
//      `expired` carries that fact to the screen so it can say what happened.
// =============================================================================

export interface SessionFacts {
  /** The identity that survived the last launch, or null. */
  member: Member | null;
  /** True once a rotation has minted the in-memory access token. */
  hasAccessToken: boolean;
  /** Set when a 401 survived a rotation: the session is over, not slow. */
  authExpired: boolean;
  /** False while the boot-time `restoreSession()` rotation is in flight. */
  restoreSettled: boolean;
}

export type AuthGate =
  /** Nothing to show yet. Never a form, never a shell — see (1) and (2) above. */
  | {kind: 'restoring'}
  | {kind: 'signedOut'; expired: boolean}
  | {kind: 'signedIn'; member: Member};

export function authGate(facts: SessionFacts): AuthGate {
  // An expired session is decided before anything else. It is the one state that
  // can hold a member AND a stale token at the same time, and treating it as
  // "signed in" would put the person in a shell where every query fails.
  if (facts.authExpired) return {kind: 'signedOut', expired: true};
  if (facts.member !== null && facts.hasAccessToken) {
    return {kind: 'signedIn', member: facts.member};
  }
  if (!facts.restoreSettled) return {kind: 'restoring'};
  return {kind: 'signedOut', expired: false};
}

/** What the sign-in screen says when it was reached by a session ending. */
export const SESSION_EXPIRED_NOTICE =
  '로그인이 만료되었습니다. 다시 연결해 주세요.';
