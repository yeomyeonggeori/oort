import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {registerDevice} from '../src/push/devices';
import {__setNonSecretStore} from '../src/storage/kv';
import {
  __resetSessionStore,
  getRefreshToken,
  keychainSettled,
  sessionPort,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';
import {registerWithRetry} from '../src/push/registration';

// =============================================================================
// #4008 — 푸시 기기 등록의 401 은 「갱신이 서버에 닿았는가」로 갈린다 (#3997 후속).
//
// `registerDevice` 가 boolean `refreshSession()` 을 쓰면 갱신이 닿지 못한 실패도
// false 가 되어 첫 401 이 `rejected` 로 접힌다. `worthRetrying` 은 rejected 를 다시
// 시도하지 않으므로 이번 실행의 등록 기회가 사라진다. 코어 `rotateAfterUnauthorized`
// 는 닿지 못함을 `NetworkError` 로 던지고, 아래 catch 가 `unreachable` 로 접는다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const INPUT = {
  workspaceId: WS,
  deviceId: '33333333-3333-4333-8333-333333333333',
  apnsToken: 'ab'.repeat(32),
  env: 'sandbox' as const,
  appBuild: '1',
};
const LOGIN_BODY = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: WS,
    kind: 'human' as const,
    displayName: 'Seongjae Kwak',
    handle: 'seongjae',
  },
};

type Step = 'down' | {status: number; body?: unknown};
let script: Step[];
let paths: string[];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body ?? {}), {
    status,
    headers: {'Content-Type': 'application/json'},
  });
}

beforeEach(async () => {
  const map = new Map<string, string>();
  __setNonSecretStore({
    getString: (k: string) => map.get(k),
    set: (k: string, v: string) => void map.set(k, String(v)),
    remove: (k: string) => map.delete(k),
  });
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase('https://api.example.com');
  sessionPort.applyLogin(LOGIN_BODY);
  await keychainSettled();
  paths = [];
  globalThis.fetch = jest.fn(async (input: RequestInfo | URL) => {
    paths.push(new URL(String(input)).pathname);
    const step = script.shift();
    if (step === undefined || step === 'down') {
      throw new TypeError('Network request failed');
    }
    return json(step.status, step.body);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  __setNonSecretStore(null);
});

const DEVICES = `/v1/workspaces/${WS}/devices`;
const REFRESH = '/v1/auth/refresh';

describe('registerDevice — 401 과 갱신 (#4008)', () => {
  it('갱신이 서버에 닿지 못하면 unreachable 이다 — rejected 가 아니다', async () => {
    script = [{status: 401}, 'down'];

    const outcome = await registerDevice(INPUT);

    expect(outcome.kind).toBe('unreachable');
    expect(paths).toEqual([DEVICES, REFRESH]);
    // 닿지 못한 갱신은 세션을 끝내지 않는다.
    expect(getRefreshToken()).toBe('refresh-token-1');
  });

  it('그 unreachable 은 정책이 다시 시도해 등록에 이른다', async () => {
    script = [{status: 401}, 'down', {status: 201}];

    const result = await registerWithRetry({
      workspaceId: WS,
      apnsToken: INPUT.apnsToken,
      env: 'sandbox',
      appBuild: '1',
    });

    expect(result.outcome).toEqual({kind: 'registered'});
    expect(result.attempts).toBe(2);
    expect(result.owesForegroundRetry).toBe(false);
  });

  it('거절된 갱신은 다시 시도하지 않는다', async () => {
    script = [
      {status: 401},
      {status: 401, body: {error: {message: 'refresh token already used or revoked'}}},
      {status: 201},
    ];

    const result = await registerWithRetry({
      workspaceId: WS,
      apnsToken: INPUT.apnsToken,
      env: 'sandbox',
      appBuild: '1',
    });

    expect(result.outcome).toEqual({kind: 'rejected', status: 401});
    expect(result.attempts).toBe(1);
  });

  it('서버가 갱신을 거절하면 rejected(401) 다', async () => {
    script = [
      {status: 401},
      {status: 401, body: {error: {message: 'refresh token already used or revoked'}}},
    ];

    const outcome = await registerDevice(INPUT);

    expect(outcome).toEqual({kind: 'rejected', status: 401});
    expect(paths).toEqual([DEVICES, REFRESH]);
  });

  it('갱신이 되면 새 토큰으로 다시 보내 registered 다', async () => {
    script = [
      {status: 401},
      {status: 200, body: {accessToken: 'access-new', refreshToken: 'refresh-2'}},
      {status: 201},
    ];

    const outcome = await registerDevice(INPUT);

    expect(outcome).toEqual({kind: 'registered'});
    expect(paths).toEqual([DEVICES, REFRESH, DEVICES]);
  });
});
