import {ApiError, login, logout, restoreSession} from '@momo/core/lib/api';
import {NetworkError, REQUEST_TIMEOUT_MS} from '@momo/core/lib/http';
import {
  apiBase as coreApiBase,
  buildMode,
  coreHostInstalled,
  coreSession,
} from '@momo/core/runtime/host';

import '../src/boot/polyfills';
// Importing this is what installs the host, exactly as `index.js` does.
import '../src/boot/coreHost';

import {
  __resetSessionStore,
  getAccessToken,
  getRefreshToken,
  hasPersistedSession,
  initSessionStore,
  keychainSettled,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// This batch's completion condition is "attached", not "boots". This file is
// where that is demonstrated: the app's host implementations are driven THROUGH
// `@momo/core`'s own API layer, over React Native's `fetch`, with no server.
//
// What is proved, in order:
//   1. the host port is installed, and the core reads this client's answers;
//   2. `login()` builds its URL from the MMKV-backed base and decodes the wire;
//   3. the refresh token lands in the KEYCHAIN and never in MMKV (D7);
//   4. a 401 surfaces as `ApiError`, a dead server as `NetworkError` — the core's
//      contract that those two are never the same thing;
//   5. a stored session resumes through one refresh rotation.
//
// The server is mocked because contacting the real one (app.oor7.com) needs
// credentials and is the orchestrator's job. Everything between this client's
// storage and the HTTP boundary is real code.
// =============================================================================

const MEMBER = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  kind: 'human',
  displayName: 'Seongjae Kwak',
  handle: 'seongjae',
};

const LOGIN_BODY = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: MEMBER,
};

// The in-memory doubles from `jest.setup.js`. Reached through `requireMock` so
// the mock's inspection handles are not pretended to be part of the real
// modules' public API.
const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;
const keychainItems = (
  jest.requireMock('react-native-keychain') as {
    __items: Map<string, {password: string; options: {accessible?: string}}>;
  }
).__items;

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

type FetchMock = jest.Mock<Promise<Response>, [string, RequestInit?]>;

let fetchMock: FetchMock;

beforeEach(() => {
  mmkvStore.clear();
  keychainItems.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  fetchMock = jest.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe('the host port', () => {
  it('is installed by importing src/boot/coreHost', () => {
    expect(coreHostInstalled()).toBe(true);
  });

  it('answers a build mode, because import.meta does not exist under Hermes', () => {
    expect(['development', 'production']).toContain(buildMode());
  });

  it('hands the core the base this device stored in MMKV', () => {
    expect(coreApiBase()).toBe('');
    setServerBase('https://api.example.com');
    expect(coreApiBase()).toBe('https://api.example.com');
    // Stored, not just remembered in a module variable.
    expect(mmkvStore.get('momo.mobile.server.v1')).toBe('https://api.example.com');
  });

  it('re-validates the stored base on read rather than trusting it', () => {
    mmkvStore.set('momo.mobile.server.v1', 'ws://not-a-web-address');
    __resetServerBaseCache();
    expect(coreApiBase()).toBe('');
  });
});

describe('login, end to end through the core', () => {
  beforeEach(() => {
    setServerBase('https://api.example.com');
  });

  it('builds the request from the stored base and adopts the response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, LOGIN_BODY));

    const response = await login('seongjae@example.com', 'pw');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/auth/login');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      email: 'seongjae@example.com',
      password: 'pw',
    });

    // Decoded by the core's wire decoder, not by this client.
    expect(response.member.displayName).toBe('Seongjae Kwak');
    expect(coreSession().getAccessToken()).toBe('access-token-1');
  });

  it('puts the refresh token in the keychain and NOT in MMKV', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, LOGIN_BODY));
    await login('seongjae@example.com', 'pw');
    await keychainSettled();

    const stored = keychainItems.get('app.momo.ios.rn.session');
    expect(stored?.password).toBe('refresh-token-1');
    // Locked and device-scoped: the NSE must read it while the phone is locked,
    // and it must not ride an iCloud backup to a second device.
    expect(stored?.options.accessible).toBe(
      'AccessibleAfterFirstUnlockThisDeviceOnly',
    );

    // The whole of ADR-0137 D7 in one assertion: no value anywhere in the
    // non-secret store may be, or contain, the refresh token.
    for (const value of mmkvStore.values()) {
      expect(value).not.toContain('refresh-token-1');
    }
  });

  it('keeps the non-secret metadata where a relaunch can find it', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, LOGIN_BODY));
    await login('seongjae@example.com', 'pw');

    const metadata = JSON.parse(
      String(mmkvStore.get('momo.mobile.session.meta.v1')),
    );
    expect(metadata.member.id).toBe(MEMBER.id);
    // ADR-0110: the websocket address is the server's to state, and the refresh
    // response does not repeat it, so it has to survive here.
    expect(metadata.realtimeWebSocketUrl).toBe(
      'wss://api.example.com/connection/websocket',
    );
    expect(metadata.refreshToken).toBeUndefined();
  });

  it('surfaces a 401 as ApiError, carrying the server’s own message', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, {error: {message: '이메일 또는 비밀번호가 올바르지 않습니다.'}}),
    );

    await expect(login('seongjae@example.com', 'wrong')).rejects.toThrow(
      ApiError,
    );
    expect(getRefreshToken()).toBeNull();
    expect(keychainItems.size).toBe(0);
  });

  it('surfaces an unreachable server as NetworkError, not as a rejection', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));

    const error = await login('seongjae@example.com', 'pw').catch(e => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(error.failure).toBe('unreachable');
    // A wrong password and a dead server must never read as the same thing.
    expect(error).not.toBeInstanceOf(ApiError);
  });

  it('surfaces a server that never answers as a timeout, within the deadline', async () => {
    jest.useFakeTimers();
    try {
      fetchMock.mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new Error('aborted')),
            );
          }),
      );

      const pending = login('seongjae@example.com', 'pw').catch(e => e);
      jest.advanceTimersByTime(REQUEST_TIMEOUT_MS + 1);
      const error = await pending;

      expect(error).toBeInstanceOf(NetworkError);
      expect(error.failure).toBe('timeout');
      // The copy tells the person the deadline and what to do, in Korean.
      expect(error.message).toContain('15초');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('resume and sign out', () => {
  beforeEach(() => {
    setServerBase('https://api.example.com');
  });

  it('resumes a stored session with exactly one rotation', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, LOGIN_BODY));
    await login('seongjae@example.com', 'pw');
    await keychainSettled();

    // A relaunch: memory is gone, the keychain and MMKV are not.
    __resetSessionStore();
    expect(hasPersistedSession()).toBe(false);
    await initSessionStore();
    expect(hasPersistedSession()).toBe(true);
    // The access token is deliberately not persisted.
    expect(getAccessToken()).toBeNull();

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        accessToken: 'access-token-2',
        refreshToken: 'refresh-token-2',
      }),
    );
    const restored = await restoreSession();

    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://api.example.com/v1/auth/refresh',
      expect.anything(),
    );
    expect(restored?.member.id).toBe(MEMBER.id);
    // The websocket address came from storage, never re-derived from the base.
    expect(restored?.realtimeWebSocketUrl).toBe(
      'wss://api.example.com/connection/websocket',
    );
    await keychainSettled();
    expect(keychainItems.get('app.momo.ios.rn.session')?.password).toBe(
      'refresh-token-2',
    );
  });

  it('erases the device copy before the network revocation is attempted', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, LOGIN_BODY));
    await login('seongjae@example.com', 'pw');
    await keychainSettled();

    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    await logout();
    await keychainSettled();

    // A failing revoke must not leave a usable token behind on the phone.
    expect(getRefreshToken()).toBeNull();
    expect(getAccessToken()).toBeNull();
    expect(keychainItems.size).toBe(0);
    expect(mmkvStore.get('momo.mobile.session.meta.v1')).toBeUndefined();
  });
});
