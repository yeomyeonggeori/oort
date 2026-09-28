import {login, refreshSessionOutcome} from '@momo/core/lib/api';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {
  __resetSessionStore,
  keychainSettled,
  ROTATION_KEYCHAIN_WAIT_MS,
  ROTATION_TASK_NAME,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// #3098 — a refresh rotation runs inside ONE iOS background task, begun before
// the POST leaves and ended only after the new token is in the keychain.
//
// iOS freezes the app about five seconds after it leaves the foreground. What
// cannot be reproduced under Jest is the freeze itself; what can is the
// bracket that decides whether iOS grants the time: the server here answers
// only when the test says so (the "slow response while the person swipes the
// app away"), the keychain write lands only when the test says so, and every
// step is logged. Suspension on a real device is runtime-unverified.
// =============================================================================

// Built inside the factory: `jest.mock` runs before this file's own `const`s
// are initialised, and the module under test reads the native module at import.
jest.mock('expo-modules-core', () => {
  const log: string[] = [];
  const native = {
    begin: jest.fn(async (name: string): Promise<number | null> => {
      log.push(`begin:${name}`);
      return 7;
    }),
    end: jest.fn(async (handle: number): Promise<string> => {
      log.push(`end:${handle}`);
      return 'ended';
    }),
  };
  return {
    __backgroundTask: {log, native},
    requireOptionalNativeModule: jest.fn((name: string) =>
      name === 'MomoBackgroundTask' ? native : null,
    ),
    requireNativeModule: jest.fn(() => {
      throw new Error('native module unavailable under Jest');
    }),
    requireNativeViewManager: jest.fn(() => require('react-native').View),
  };
});

const {log: mockLog, native: mockNative} = (
  jest.requireMock('expo-modules-core') as {
    __backgroundTask: {
      log: string[];
      native: {begin: jest.Mock; end: jest.Mock};
    };
  }
).__backgroundTask;

const keychain = jest.requireMock('react-native-keychain') as {
  __items: Map<string, {password: string}>;
  setGenericPassword: jest.Mock;
};
// The shared double's own implementation, restored before every test so a
// write lever a failed request never pulled cannot leak into the next test.
const realSetGenericPassword = keychain.setGenericPassword.getMockImplementation()!;
const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;

const MEMBER = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  kind: 'human',
  displayName: 'Seongjae Kwak',
  handle: 'seongjae',
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function deferred<T>(): {promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
}

/** Let every queued microtask and resolved promise run. */
const flush = () => new Promise(r => setImmediate(r));

const storedToken = () => keychain.__items.get('app.momo.ios.rn.session')?.password;

/**
 * Signs in, then arms a refresh whose response and keychain write both wait
 * for the test. Returns the two levers.
 */
async function signedInWithSlowRotation() {
  const fetchMock = jest.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockResolvedValueOnce(
    jsonResponse(200, {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
      member: MEMBER,
    }),
  );
  await login('seongjae@example.com', 'pw');
  await keychainSettled();
  mockLog.length = 0;

  const server = deferred<Response>();
  fetchMock.mockImplementationOnce((url: string) => {
    mockLog.push(`fetch:${url.replace('https://api.example.com', '')}`);
    return server.promise;
  });
  const write = deferred<void>();
  keychain.setGenericPassword.mockImplementationOnce(async (...args: unknown[]) => {
    mockLog.push('keychain:write-started');
    await write.promise;
    const result = await realSetGenericPassword(...args);
    mockLog.push('keychain:written');
    return result;
  });
  return {fetchMock, server, write};
}

beforeEach(() => {
  mmkvStore.clear();
  keychain.__items.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase('https://api.example.com');
  mockLog.length = 0;
  mockNative.begin.mockClear();
  mockNative.end.mockClear();
  keychain.setGenericPassword.mockReset();
  keychain.setGenericPassword.mockImplementation(realSetGenericPassword);
});

describe('a rotation holds an iOS background task until its token is stored (#3098)', () => {
  it('begins before the POST leaves and ends only after the keychain write', async () => {
    const {server, write} = await signedInWithSlowRotation();

    const outcome = refreshSessionOutcome();
    await flush();
    // The request is in the air — this is the moment the app goes to the
    // background. The task must already be open.
    expect(mockLog).toEqual([`begin:${ROTATION_TASK_NAME}`, 'fetch:/v1/auth/refresh']);

    server.resolve(jsonResponse(200, {accessToken: 'access-2', refreshToken: 'refresh-2'}));
    await flush();
    // The response arrived, the server has revoked refresh-1, and the write of
    // refresh-2 has not landed. Ending the task here is the bug.
    expect(mockLog).toEqual([
      `begin:${ROTATION_TASK_NAME}`,
      'fetch:/v1/auth/refresh',
      'keychain:write-started',
    ]);
    expect(storedToken()).toBe('refresh-1');

    write.resolve();
    await expect(outcome).resolves.toBe('rotated');
    expect(mockLog).toEqual([
      `begin:${ROTATION_TASK_NAME}`,
      'fetch:/v1/auth/refresh',
      'keychain:write-started',
      'keychain:written',
      'end:7',
    ]);
    expect(storedToken()).toBe('refresh-2');
    expect(mockNative.begin).toHaveBeenCalledTimes(1);
    expect(mockNative.end).toHaveBeenCalledTimes(1);
  });

  it('still ends the task when the request fails', async () => {
    const {server} = await signedInWithSlowRotation();
    const outcome = refreshSessionOutcome();
    await flush();
    server.reject(new TypeError('Network request failed'));
    await expect(outcome).resolves.toBe('unreachable');
    expect(mockLog).toEqual([`begin:${ROTATION_TASK_NAME}`, 'fetch:/v1/auth/refresh', 'end:7']);
    expect(storedToken()).toBe('refresh-1');
  });

  it('says so, and keeps the stored token whole, when iOS expired the task first', async () => {
    const {server, write} = await signedInWithSlowRotation();
    mockNative.end.mockImplementationOnce(async (handle: number) => {
      mockLog.push(`end:${handle}`);
      return 'expired';
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const outcome = refreshSessionOutcome();
      await flush();
      server.resolve(jsonResponse(200, {accessToken: 'access-2', refreshToken: 'refresh-2'}));
      await flush();
      // Suspended here; the process resumed later and the write completed.
      write.resolve();
      await expect(outcome).resolves.toBe('rotated');
      expect(storedToken()).toBe('refresh-2');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`"${ROTATION_TASK_NAME}" outlived its time`),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('rotates without extra time when iOS refuses the task', async () => {
    const {server, write} = await signedInWithSlowRotation();
    mockNative.begin.mockImplementationOnce(async () => null);
    const outcome = refreshSessionOutcome();
    await flush();
    server.resolve(jsonResponse(200, {accessToken: 'access-2', refreshToken: 'refresh-2'}));
    write.resolve();
    await expect(outcome).resolves.toBe('rotated');
    expect(mockNative.end).not.toHaveBeenCalled();
    expect(storedToken()).toBe('refresh-2');
  });

  it('rotates when the native begin throws', async () => {
    const {server, write} = await signedInWithSlowRotation();
    mockNative.begin.mockImplementationOnce(async () => {
      throw new Error('bridge down');
    });
    const outcome = refreshSessionOutcome();
    await flush();
    server.resolve(jsonResponse(200, {accessToken: 'access-2', refreshToken: 'refresh-2'}));
    write.resolve();
    await expect(outcome).resolves.toBe('rotated');
    expect(storedToken()).toBe('refresh-2');
  });

  it('lets go of the task after a bounded wait when the keychain never answers', async () => {
    const {server} = await signedInWithSlowRotation();
    jest.useFakeTimers({doNotFake: ['setImmediate', 'nextTick']});
    try {
      const outcome = refreshSessionOutcome();
      await flush();
      server.resolve(jsonResponse(200, {accessToken: 'access-2', refreshToken: 'refresh-2'}));
      await flush();
      expect(mockLog).not.toContain('end:7');
      await jest.advanceTimersByTimeAsync(ROTATION_KEYCHAIN_WAIT_MS - 1);
      expect(mockLog).not.toContain('end:7');
      await jest.advanceTimersByTimeAsync(1);
      await expect(outcome).resolves.toBe('rotated');
      expect(mockLog[mockLog.length - 1]).toBe('end:7');
    } finally {
      jest.useRealTimers();
    }
  });
});
