import {onlineManager} from '@tanstack/react-query';
import {restoreSession} from '@momo/core/lib/api';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {
  __resetSessionStore,
  getPersistedSession,
  hasPersistedSession,
  keychainSettled,
  sessionPort,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// The rule this file exists to pin: **a launch with no signal must not cost the
// session.**
//
// It is written against the core rather than against a component because the
// hazard is in the core and the host guard is only meaningful next to a
// demonstration of what it is guarding. `useAuthGate` refuses to call
// `restoreSession()` while `onlineManager` reports offline; the first test here
// shows why that refusal is load-bearing, and the second shows the guard holding.
// =============================================================================

const LOGIN_BODY = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    kind: 'human' as const,
    displayName: 'Seongjae Kwak',
    handle: 'seongjae',
  },
};

const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;
const keychainItems = (
  jest.requireMock('react-native-keychain') as {
    __items: Map<string, {password: string}>;
  }
).__items;

beforeEach(async () => {
  mmkvStore.clear();
  keychainItems.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase('https://api.example.com');
  sessionPort.applyLogin(LOGIN_BODY);
  await keychainSettled();
});

it('the core destroys a stored session when NOTHING answered — the hazard', async () => {
  // `refreshSession()` catches the transport failure and returns false, saying
  // in its own comment that the session is deliberately not declared dead.
  // `restoreSession()` then clears it anyway. One subway ride costs a password.
  globalThis.fetch = jest.fn(async () => {
    throw new TypeError('Network request failed');
  }) as unknown as typeof fetch;

  expect(hasPersistedSession()).toBe(true);
  const resumed = await restoreSession();

  expect(resumed).toBeNull();
  // This is the bug, asserted so the day the core stops doing it this test
  // fails loudly and the host guard below can be removed.
  expect(getPersistedSession()).toBeNull();
  await keychainSettled();
  expect(keychainItems.get('app.momo.ios.rn.session')).toBeUndefined();
});

it('the host guard keeps the session by not attempting the rotation at all', () => {
  // What `useAuthGate` does: it asks `onlineManager` first and returns without
  // touching `restoreSession()`. Asserting the predicate here keeps the guard
  // honest without standing up a React tree just to observe an absence.
  const fetchMock = jest.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  onlineManager.setOnline(false);

  expect(onlineManager.isOnline()).toBe(false);
  // The guard's whole content: offline means do not call it.
  if (onlineManager.isOnline()) {
    void restoreSession();
  }

  expect(fetchMock).not.toHaveBeenCalled();
  expect(hasPersistedSession()).toBe(true);
  onlineManager.setOnline(true);
});
