import type {LoginResponse} from '@momo/core/lib/api';

import {__setNonSecretStore, NON_SECRET_KEYS} from '../src/storage/kv';
import {
  __resetSessionStore,
  applyLogin,
  applyRotation,
  clearSession,
  getRefreshToken,
  hasPersistedSession,
  initSessionStore,
  keychainSettled,
  KEYCHAIN_SERVICE,
} from '../src/storage/secureSession';

// =============================================================================
// #3121 — the refresh token is the app's alone.
//
// Before: it was written with no access group, which on a device with a
// `keychain-access-groups` entitlement means the FIRST group listed — the one
// shared with the notification extension. The extension therefore held a
// credential it could spend for a fresh session. After: it is written to the
// app-only group, and installs from before are moved on the first launch.
//
// The mockKeychain double below is group-aware (the shared jest one keys by service
// only, which is exactly what could not answer "which group is it in"). It
// follows the real semantics that matter here:
//   - a read/delete that names a group touches that group only;
//   - a read/delete that names none matches across all groups.
// =============================================================================

const SHARED = 'TEAM123456.app.momo.ios.shared';
const APP_ONLY = 'TEAM123456.app.momo.ios.devicekey';

const mockKeychain = new Map<string, string>();
const mockKey = (service: string, group: string | undefined) =>
  `${service}|${group ?? ''}`;
let mockFailWritesTo: string | null = null;

jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: {AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afutdo'},
  setGenericPassword: jest.fn(
    async (
      _u: string,
      password: string,
      o: {service: string; accessGroup?: string},
    ) => {
      if (mockFailWritesTo !== null && o.accessGroup === mockFailWritesTo) {
        throw new Error('keychain write refused');
      }
      mockKeychain.set(mockKey(o.service, o.accessGroup), password);
      return {service: o.service, storage: 'keychain'};
    },
  ),
  getGenericPassword: jest.fn(
    async (o: {service: string; accessGroup?: string}) => {
      if (o.accessGroup !== undefined) {
        const hit = mockKeychain.get(mockKey(o.service, o.accessGroup));
        return hit === undefined ? false : {username: 'refreshToken', password: hit};
      }
      for (const [k, v] of mockKeychain) {
        if (k.startsWith(`${o.service}|`)) {
          return {username: 'refreshToken', password: v};
        }
      }
      return false;
    },
  ),
  resetGenericPassword: jest.fn(
    async (o: {service: string; accessGroup?: string}) => {
      if (o.accessGroup !== undefined) {
        return mockKeychain.delete(mockKey(o.service, o.accessGroup));
      }
      let any = false;
      for (const k of [...mockKeychain.keys()]) {
        if (k.startsWith(`${o.service}|`)) {
          mockKeychain.delete(k);
          any = true;
        }
      }
      return any;
    },
  ),
}));

jest.mock('../src/push/native', () => ({
  keychainAccessGroup: jest.fn(() => SHARED),
}));

const LOGIN: LoginResponse = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    kind: 'human',
    displayName: 'Seongjae Kwak',
    handle: 'seongjae',
  },
} as LoginResponse;

function memoryStore() {
  const map = new Map<string, string>();
  return {
    map,
    getString: (k: string) => map.get(k),
    set: (k: string, v: string) => void map.set(k, String(v)),
    remove: (k: string) => map.delete(k),
  };
}

let store: ReturnType<typeof memoryStore>;

beforeEach(() => {
  mockKeychain.clear();
  mockFailWritesTo = null;
  store = memoryStore();
  __setNonSecretStore(store);
  __resetSessionStore();
});

const inShared = () => mockKeychain.get(mockKey(KEYCHAIN_SERVICE, SHARED));
const inAppOnly = () => mockKeychain.get(mockKey(KEYCHAIN_SERVICE, APP_ONLY));
const anywhereElse = () =>
  [...mockKeychain.keys()].filter(
    k => k !== mockKey(KEYCHAIN_SERVICE, SHARED) && k !== mockKey(KEYCHAIN_SERVICE, APP_ONLY),
  );

/** An install from before #3121: token in the shared group, metadata in MMKV. */
async function legacyInstall(token = 'refresh-legacy') {
  applyLogin(LOGIN); // only to produce real metadata, then start over
  await keychainSettled();
  const metadata = store.map.get(NON_SECRET_KEYS.sessionMetadata) as string;
  mockKeychain.clear();
  __resetSessionStore();
  store.map.set(NON_SECRET_KEYS.sessionMetadata, metadata);
  mockKeychain.set(mockKey(KEYCHAIN_SERVICE, SHARED), token);
}

describe('where the refresh token is written', () => {
  it('sign-in puts it in the app-only group and nowhere else', async () => {
    applyLogin(LOGIN);
    await keychainSettled();
    expect(inAppOnly()).toBe('refresh-1');
    expect(inShared()).toBeUndefined();
    expect(anywhereElse()).toEqual([]);
  });

  it('a rotation replaces it in the app-only group and never touches shared', async () => {
    applyLogin(LOGIN);
    applyRotation('access-2', 'refresh-2');
    await keychainSettled();
    expect(inAppOnly()).toBe('refresh-2');
    expect(inShared()).toBeUndefined();
  });

  it('sign-out deletes it from every group', async () => {
    await legacyInstall();
    mockKeychain.set(mockKey(KEYCHAIN_SERVICE, APP_ONLY), 'refresh-x');
    clearSession();
    await keychainSettled();
    expect([...mockKeychain.keys()]).toEqual([]);
  });
});

describe('an install from before #3121', () => {
  it('keeps its session and moves the token: written, verified, then deleted from shared', async () => {
    await legacyInstall('refresh-legacy');
    await initSessionStore();
    // Usable at once — before the move has even run.
    expect(hasPersistedSession()).toBe(true);
    expect(getRefreshToken()).toBe('refresh-legacy');

    await keychainSettled();
    expect(inAppOnly()).toBe('refresh-legacy');
    expect(inShared()).toBeUndefined();
    expect(getRefreshToken()).toBe('refresh-legacy');
  });

  it('a refused new write signs nobody out and leaves the shared copy for the next launch', async () => {
    await legacyInstall('refresh-legacy');
    mockFailWritesTo = APP_ONLY;
    await initSessionStore();
    await keychainSettled();

    expect(hasPersistedSession()).toBe(true);
    expect(getRefreshToken()).toBe('refresh-legacy');
    expect(inShared()).toBe('refresh-legacy'); // NOT deleted: it is the only copy
    expect(inAppOnly()).toBeUndefined();

    // Next launch, the mockKeychain cooperates.
    mockFailWritesTo = null;
    __resetSessionStore();
    store.map.set(
      NON_SECRET_KEYS.sessionMetadata,
      store.map.get(NON_SECRET_KEYS.sessionMetadata) as string,
    );
    await initSessionStore();
    await keychainSettled();
    expect(inAppOnly()).toBe('refresh-legacy');
    expect(inShared()).toBeUndefined();
  });

  it('after a refused move, the next successful write also clears the shared copy', async () => {
    await legacyInstall('refresh-legacy');
    mockFailWritesTo = APP_ONLY;
    await initSessionStore();
    await keychainSettled();
    expect(inShared()).toBe('refresh-legacy');

    mockFailWritesTo = null; // the keychain recovers mid-run
    applyRotation('access-2', 'refresh-2');
    await keychainSettled();
    expect(inAppOnly()).toBe('refresh-2');
    expect(inShared()).toBeUndefined();
  });

  it('a leftover shared copy next to the app-only one is swept, and the app-only one wins', async () => {
    await legacyInstall('refresh-stale');
    mockKeychain.set(mockKey(KEYCHAIN_SERVICE, APP_ONLY), 'refresh-current');
    await initSessionStore();
    await keychainSettled();
    expect(getRefreshToken()).toBe('refresh-current');
    expect(inAppOnly()).toBe('refresh-current');
    expect(inShared()).toBeUndefined();
  });

  it('with no token in either group the half-session is cleared, as before', async () => {
    await legacyInstall();
    mockKeychain.clear();
    await initSessionStore();
    await keychainSettled();
    expect(hasPersistedSession()).toBe(false);
    expect(store.map.has(NON_SECRET_KEYS.sessionMetadata)).toBe(false);
  });
});
