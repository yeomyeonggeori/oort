import type {Member} from '@momo/core/lib/api';
import {authGate, type SessionFacts} from '../src/session/authGate';

// =============================================================================
// The three-way decision that stands between a launch and a screen.
//
// Each case here is a real failure this shape prevents, and the reason they are
// worth pinning is that all three are invisible in the happy path: a fresh
// install and a warm relaunch both look fine while the middle state is wrong.
// =============================================================================

const MEMBER: Member = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  kind: 'human',
  displayName: 'Seongjae Kwak',
  handle: 'seongjae',
};

function facts(overrides: Partial<SessionFacts> = {}): SessionFacts {
  return {
    member: null,
    hasAccessToken: false,
    authExpired: false,
    restoreSettled: true,
    ...overrides,
  };
}

describe('a first-time launch', () => {
  it('asks for a sign-in, without claiming anything expired', () => {
    expect(authGate(facts())).toEqual({kind: 'signedOut', expired: false});
  });

  it('does not flash a restoring state when there is nothing to restore', () => {
    // `restoreSettled` is seeded from `hasPersistedSession()`, so a fresh install
    // is settled before the first render. A spinner here would be a lie about
    // work that is not happening.
    expect(authGate(facts({restoreSettled: true})).kind).toBe('signedOut');
  });
});

describe('a relaunch with a stored session', () => {
  it('shows neither a form nor a shell while the rotation is in flight', () => {
    // The stored member hydrates from MMKV instantly; the access token is memory
    // only (ADR-0137 D7) and has to be re-minted. Reading this as "signed out"
    // drops a signed-in person on a login form. Reading it as "signed in" renders
    // a shell whose every request 401s.
    expect(
      authGate(facts({member: MEMBER, hasAccessToken: false, restoreSettled: false})),
    ).toEqual({kind: 'restoring'});
  });

  it('lands in the shell once the rotation minted a token', () => {
    expect(
      authGate(facts({member: MEMBER, hasAccessToken: true})),
    ).toEqual({kind: 'signedIn', member: MEMBER});
  });

  it('asks for a sign-in when the rotation settled with no token', () => {
    // `restoreSession()` wipes the store when the stored refresh token is dead,
    // so this is the shape of a 30-day-old install being opened again.
    expect(
      authGate(facts({member: null, hasAccessToken: false, restoreSettled: true})),
    ).toEqual({kind: 'signedOut', expired: false});
  });
});

describe('a session that ended mid-use', () => {
  it('says so, rather than dropping the person on a blank form', () => {
    const gate = authGate(
      facts({member: MEMBER, hasAccessToken: true, authExpired: true}),
    );
    expect(gate).toEqual({kind: 'signedOut', expired: true});
  });

  it('outranks a still-present member and token', () => {
    // `markAuthExpired` is set when a 401 survived a rotation attempt. Both a
    // member and a (now worthless) token are still in memory at that moment, and
    // any rule that checked them first would keep rendering the shell.
    const gate = authGate(
      facts({
        member: MEMBER,
        hasAccessToken: true,
        authExpired: true,
        restoreSettled: false,
      }),
    );
    expect(gate.kind).toBe('signedOut');
  });
});
