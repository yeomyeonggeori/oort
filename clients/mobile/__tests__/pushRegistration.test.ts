import {__setNonSecretStore, NON_SECRET_KEYS} from '../src/storage/kv';
import {
  PUSH_FETCH_SESSION_ACCOUNT,
  PUSH_KEYCHAIN_SERVICE,
} from '../src/push/contract';
import {
  clearPushFetchSession,
  publishPushFetchSession,
} from '../src/push/pushFetchSession';
import {
  IMMEDIATE_ATTEMPTS,
  pushDeviceId,
  registerWithRetry,
} from '../src/push/registration';

const keychain = require('react-native-keychain');
// `mock`-prefixed by necessity: jest hoists the factory above this file's own
// declarations and rejects any other out-of-scope name.
const mockKeychainAccessGroup = jest.fn();

jest.mock('../src/push/native', () => ({
  keychainAccessGroup: () => mockKeychainAccessGroup(),
  apnsEnvironment: () => 'sandbox',
  pushNativeModuleAvailable: () => true,
}));

function memoryStore() {
  const map = new Map<string, string>();
  return {
    getString: (k: string) => map.get(k),
    set: (k: string, v: string) => void map.set(k, v),
    remove: (k: string) => map.delete(k),
  };
}

beforeEach(() => {
  __setNonSecretStore(memoryStore());
  keychain.__items.clear();
  mockKeychainAccessGroup.mockReturnValue('YWQQFQM38J.app.momo.ios.shared');
});

afterEach(() => __setNonSecretStore(null));

describe('device id', () => {
  it('is minted once and then reused', () => {
    // A new id per launch would leave a dead device row behind on every cold
    // start and multiply every push by the number of launches.
    const first = pushDeviceId();
    expect(pushDeviceId()).toBe(first);
  });

  it('lives in the non-secret store, not the keychain', () => {
    // The keychain SURVIVES app deletion on iOS; a reinstall would silently
    // reclaim the previous install's device row and its stale APNs token.
    const id = pushDeviceId();
    const store = memoryStore();
    __setNonSecretStore(store);
    expect(store.getString(NON_SECRET_KEYS.pushDeviceId)).toBeUndefined();
    __setNonSecretStore(null);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('registration retry policy (PushNotificationCoordinator.swift:185-227)', () => {
  const request = {
    workspaceId: 'ws-1',
    apnsToken: 'abc123',
    env: 'sandbox' as const,
    appBuild: null,
  };

  it('stops at the first success', async () => {
    const register = jest.fn().mockResolvedValue({kind: 'registered'});
    const result = await registerWithRetry(request, register);
    expect(result.attempts).toBe(1);
    expect(result.owesForegroundRetry).toBe(false);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('retries an unreachable server, then owes one foreground attempt', async () => {
    const register = jest
      .fn()
      .mockResolvedValue({kind: 'unreachable', reason: 'timeout'});
    const result = await registerWithRetry(request, register);
    expect(register).toHaveBeenCalledTimes(IMMEDIATE_ATTEMPTS);
    expect(result.owesForegroundRetry).toBe(true);
  });

  it('succeeds on the second attempt without owing a third', async () => {
    const register = jest
      .fn()
      .mockResolvedValueOnce({kind: 'unreachable', reason: 'timeout'})
      .mockResolvedValueOnce({kind: 'registered'});
    const result = await registerWithRetry(request, register);
    expect(result.attempts).toBe(2);
    expect(result.owesForegroundRetry).toBe(false);
  });

  it('does NOT retry a rejection', async () => {
    // 403 means this member may not register this device. Repeating the request
    // cannot change the answer, and a phone nobody is looking at would keep
    // asking forever.
    const register = jest.fn().mockResolvedValue({kind: 'rejected', status: 403});
    const result = await registerWithRetry(request, register);
    expect(register).toHaveBeenCalledTimes(1);
    expect(result.owesForegroundRetry).toBe(false);
  });

  it('does retry the conflict the server marks retryable', async () => {
    const register = jest.fn().mockResolvedValue({kind: 'retryable', status: 409});
    await registerWithRetry(request, register);
    expect(register).toHaveBeenCalledTimes(IMMEDIATE_ATTEMPTS);
  });
});

describe('the fetch session handed to the extension', () => {
  it('writes the exact coordinates PushNotification.swift queries', async () => {
    const outcome = await publishPushFetchSession({
      baseUrl: 'https://oort.local:28001',
      workspaceId: 'ws-1',
      accessToken: 'token-1',
    });
    expect(outcome.kind).toBe('published');

    const item = keychain.__items.get(PUSH_KEYCHAIN_SERVICE);
    expect(item.username).toBe(PUSH_FETCH_SESSION_ACCOUNT);
    expect(item.options.accessGroup).toBe('YWQQFQM38J.app.momo.ios.shared');
    // The extension reads on a locked screen — that is when a push arrives.
    // WHEN_UNLOCKED would break the feature exactly when it is used.
    expect(item.options.accessible).toBe(
      'AccessibleAfterFirstUnlockThisDeviceOnly',
    );
  });

  it('encodes the three keys Swift decodes, capitalisation included', () => {
    // PushFetchSession has no CodingKeys, so JSONDecoder matches property names
    // verbatim: baseURL, workspaceID, accessToken. `baseUrl` would decode to
    // nothing and the extension would fail open.
    return publishPushFetchSession({
      baseUrl: 'https://oort.local:28001',
      workspaceId: 'ws-1',
      accessToken: 'token-1',
    }).then(() => {
      const item = keychain.__items.get(PUSH_KEYCHAIN_SERVICE);
      expect(JSON.parse(item.password)).toEqual({
        baseURL: 'https://oort.local:28001',
        workspaceID: 'ws-1',
        accessToken: 'token-1',
      });
    });
  });

  it('refuses to write when the access group is unresolved', async () => {
    // Writing without a group puts the item in the app's private group, where
    // the extension cannot see it — and the write REPORTS SUCCESS. Refusing is
    // the only outcome that can be noticed.
    mockKeychainAccessGroup.mockReturnValue(null);
    const outcome = await publishPushFetchSession({
      baseUrl: 'https://oort.local:28001',
      workspaceId: 'ws-1',
      accessToken: 'token-1',
    });
    expect(outcome).toEqual({kind: 'no-access-group'});
    expect(keychain.__items.has(PUSH_KEYCHAIN_SERVICE)).toBe(false);
  });

  it('clears the session on sign-out', async () => {
    await publishPushFetchSession({
      baseUrl: 'https://oort.local:28001',
      workspaceId: 'ws-1',
      accessToken: 'token-1',
    });
    await clearPushFetchSession();
    expect(keychain.__items.has(PUSH_KEYCHAIN_SERVICE)).toBe(false);
  });

  it('never touches the app session keychain item', async () => {
    // Two services, deliberately: react-native-keychain deletes by SERVICE
    // before writing, so sharing one would make each write clear the other.
    await publishPushFetchSession({
      baseUrl: 'https://oort.local:28001',
      workspaceId: 'ws-1',
      accessToken: 'token-1',
    });
    expect(PUSH_KEYCHAIN_SERVICE).not.toBe('app.momo.ios.rn.session');
    expect(keychain.__items.has('app.momo.ios.rn.session')).toBe(false);
  });
});
