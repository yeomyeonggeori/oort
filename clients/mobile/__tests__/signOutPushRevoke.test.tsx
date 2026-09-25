import {refreshSessionOutcome} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render, waitFor} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {SessionProvider, useSession} from '../src/session/useSession';
import {__setNonSecretStore, NON_SECRET_KEYS} from '../src/storage/kv';
import {
  __resetSessionStore,
  getAccessToken,
  keychainSettled,
  sessionPort,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// #2677 — 로그아웃하면 이 폰의 푸시 등록도 지운다 (ADR-0120 D4 「DELETE — 로그아웃 시
// invalidate」).
//
// `revokeDevice`(`src/push/devices.ts`)는 있었지만 부르는 곳이 0곳이었다. 로그아웃한
// 폰은 앞 사람의 「oort / 새 알림」과 배지를 계속 받았다 — 알림 확장은 세션이 없으면
// relay 자리표시를 그대로 띄운다(fail-open).
//
// 서버가 이제 세션이 끝나면 그 세션의 등록을 스스로 끝낸다(#2677 서버 PR). 이
// 요청은 그 보조다: 그 서버를 아직 받지 못한 셀프호스트에서도 로그아웃이 등록을
// 끝내게 하고, 서버에 남는 기록(`invalidated_at`)을 곧바로 참으로 만든다.
//
// 이 파일이 못박는 것 셋:
//   1. 로그아웃이 DELETE /v1/workspaces/{ws}/devices/{이 기기 id}를 보낸다.
//   2. 그 요청은 **떠나는 세션의 access 토큰**을 싣는다. 로컬 세션은 이미 지워졌으므로
//      저장소에서 읽으면 무인증이다.
//   3. 그 요청은 POST /v1/auth/logout **보다 먼저** 간다. 뒤에 가면 토큰이 이미
//      회수되어 401이다 — 「가끔 되는 수리」가 된다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';

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

interface Call {
  method: string;
  path: string;
  authorization: string | null;
}

let calls: Call[];
let failDeviceRevoke: boolean;

function memoryStore() {
  const map = new Map<string, string>();
  return {
    map,
    getString: (key: string) => map.get(key),
    set: (key: string, value: string) => void map.set(key, String(value)),
    remove: (key: string) => map.delete(key),
  };
}

let store: ReturnType<typeof memoryStore>;

beforeEach(async () => {
  store = memoryStore();
  __setNonSecretStore(store);
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase('https://api.example.com');
  sessionPort.applyLogin(LOGIN_BODY);
  await keychainSettled();

  calls = [];
  failDeviceRevoke = false;
  globalThis.fetch = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      const call = {
        method: init?.method ?? 'GET',
        path: url.pathname,
        authorization: headers.get('Authorization'),
      };
      calls.push(call);
      if (call.method === 'DELETE' && failDeviceRevoke) {
        throw new TypeError('Network request failed');
      }
      return new Response(JSON.stringify({status: 'ok'}), {
        status: 200,
        headers: {'Content-Type': 'application/json'},
      });
    },
  ) as unknown as typeof fetch;
});

afterEach(() => {
  __setNonSecretStore(null);
});

/** 앱이 실제로 쓰는 `signOut` 을 그 provider 에서 그대로 꺼내 온다. */
function signOutFromApp(): () => void {
  let captured: (() => void) | null = null;
  function Probe(): React.JSX.Element | null {
    captured = useSession().signOut;
    return null;
  }
  const client = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}},
  });
  render(
    <QueryClientProvider client={client}>
      <SessionProvider member={LOGIN_BODY.member as never}>
        <Probe />
      </SessionProvider>
    </QueryClientProvider>,
  );
  if (captured === null) throw new Error('signOut 을 잡지 못했다');
  return captured;
}

const DEVICE_PATH = `/v1/workspaces/${WS}/devices/${DEVICE}`;
const LOGOUT_PATH = '/v1/auth/logout';

describe('로그아웃 — 이 폰의 푸시 등록을 지운다 (#2677)', () => {
  it('떠나는 세션의 토큰으로, 서버 로그아웃보다 먼저 기기 등록을 지운다', async () => {
    store.set(NON_SECRET_KEYS.pushDeviceId, DEVICE);

    signOutFromApp()();

    // 사람은 즉시 나간다 — 망을 기다리지 않는다.
    expect(getAccessToken()).toBeNull();

    await waitFor(() =>
      expect(calls.some(call => call.path === LOGOUT_PATH)).toBe(true),
    );
    const revoke = calls.findIndex(
      call => call.method === 'DELETE' && call.path === DEVICE_PATH,
    );
    expect(revoke).toBeGreaterThanOrEqual(0);
    expect(calls[revoke]?.authorization).toBe('Bearer access-token-1');
    const logout = calls.findIndex(call => call.path === LOGOUT_PATH);
    expect(revoke).toBeLessThan(logout);
  });

  it('기기 등록을 지우지 못해도 로그아웃은 끝까지 간다', async () => {
    store.set(NON_SECRET_KEYS.pushDeviceId, DEVICE);
    failDeviceRevoke = true;

    signOutFromApp()();

    expect(getAccessToken()).toBeNull();
    await waitFor(() =>
      expect(calls.some(call => call.path === LOGOUT_PATH)).toBe(true),
    );
    const logout = calls.find(call => call.path === LOGOUT_PATH);
    expect(logout?.authorization).toBe('Bearer access-token-1');
  });

  it('이 설치가 한 번도 등록하지 않았으면 지울 것도, 새로 만들 id도 없다', async () => {
    signOutFromApp()();

    await waitFor(() =>
      expect(calls.some(call => call.path === LOGOUT_PATH)).toBe(true),
    );
    expect(calls.filter(call => call.method === 'DELETE')).toEqual([]);
    // 로그아웃이 기기 id를 새로 발급하면 다음 등록이 서버에 죽은 행을 하나 더 남긴다.
    expect(store.map.has(NON_SECRET_KEYS.pushDeviceId)).toBe(false);
  });
});

// =============================================================================
// #2677 리뷰 R1 — 회전 경쟁(M1), 훅을 기다린다(L4), 짧은 deadline(L6).
//
// M1은 리뷰의 REVIEW-GAP-B·GAP-B-linked를 이 폰으로 옮긴 것이다. 서버는 회전
// 요청을 받는 순간 P1을 쓰고 P2를 발급한다. 폰이 그 응답을 받기 전에 로그아웃하면,
// 폰은 이미 쓰인 P1으로 logout을 보낸다. 서버는 `revokedRefresh:false`를 답하고
// P2는 서버에서 30일 산다. QR 연결 폰은 회전이 P1의 access까지 죽였으므로
// DELETE도 401이고, 등록도 산다. 아래 가짜 서버는 그 상태를 그대로 들고 있다.
// =============================================================================

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return {promise, resolve};
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {'Content-Type': 'application/json'},
  });
}

function record(input: RequestInfo | URL, init?: RequestInit): Call {
  const url = new URL(String(input));
  const call = {
    method: init?.method ?? 'GET',
    path: url.pathname,
    authorization: new Headers(init?.headers).get('Authorization'),
  };
  calls.push(call);
  return call;
}

// The core's rotation single flight is module state: a test that fails before
// releasing its rotation must not leave the next test's logout joining it.
let releaseOutstandingRotation: (() => void) | null = null;

afterEach(async () => {
  releaseOutstandingRotation?.();
  releaseOutstandingRotation = null;
  await new Promise(settle => setTimeout(settle, 0));
});

/**
 * The server as state: which tokens are alive, whether this phone's
 * registration is, and a refresh whose ANSWER the test releases. The server
 * has already rotated when the request arrives — that is the race.
 * Logout follows #2685: a logout that revokes a live refresh half ends the
 * session, and its registration with it.
 */
function fakeServer({linked}: {linked: boolean}) {
  const accessOf = new Map([['refresh-token-1', 'access-token-1']]);
  const live = new Set(['access-token-1', 'refresh-token-1']);
  const state = {registrationLive: true, deleteStatus: null as number | null};
  const rotationAnswer = deferred<void>();
  releaseOutstandingRotation = () => rotationAnswer.resolve();
  let minted = 1;
  globalThis.fetch = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = record(input, init);
      const bearer = call.authorization?.replace(/^Bearer /, '') ?? null;
      const body =
        typeof init?.body === 'string' && init.body !== ''
          ? (JSON.parse(init.body) as {refreshToken?: string})
          : {};
      if (call.path === '/v1/auth/refresh') {
        const presented = body.refreshToken ?? '';
        let answer = jsonResponse(
          {error: {message: 'refresh token already used or revoked'}},
          401,
        );
        if (live.delete(presented)) {
          // A QR-linked rotation also kills the access half it replaces.
          if (linked) live.delete(accessOf.get(presented) ?? '');
          minted += 1;
          const pair = {
            accessToken: `access-token-${minted}`,
            refreshToken: `refresh-token-${minted}`,
          };
          live.add(pair.accessToken);
          live.add(pair.refreshToken);
          accessOf.set(pair.refreshToken, pair.accessToken);
          answer = jsonResponse(pair);
        }
        await rotationAnswer.promise; // the answer is late; the state above is not
        return answer;
      }
      if (call.method === 'DELETE' && call.path === DEVICE_PATH) {
        const ok = bearer !== null && live.has(bearer);
        if (ok) state.registrationLive = false;
        state.deleteStatus = ok ? 200 : 401;
        return ok
          ? jsonResponse({status: 'ok'})
          : jsonResponse({error: {message: 'token has been revoked'}}, 401);
      }
      if (call.path === LOGOUT_PATH) {
        const revokedAccess = bearer !== null && live.delete(bearer);
        const revokedRefresh =
          typeof body.refreshToken === 'string' && live.delete(body.refreshToken);
        if (revokedRefresh) state.registrationLive = false;
        return jsonResponse({
          status: 'ok',
          revokedAccess,
          revokedRefresh,
          alreadyRevoked: !(revokedAccess || revokedRefresh),
        });
      }
      return jsonResponse({status: 'ok'});
    },
  ) as unknown as typeof fetch;
  return {
    state,
    liveRefreshTokens: () => [...live].filter(token => token.startsWith('refresh')),
    releaseRotation: () => rotationAnswer.resolve(),
  };
}

describe('로그아웃 — 진행 중인 회전에 합류한다 (#2677 리뷰 M1)', () => {
  it('회전이 도는 중에 로그아웃해도 서버에 산 세션이 남지 않는다 (REVIEW-GAP-B)', async () => {
    store.set(NON_SECRET_KEYS.pushDeviceId, DEVICE);
    const server = fakeServer({linked: false});

    const rotation = refreshSessionOutcome(); // 어딘가의 401이 시작한 회전
    signOutFromApp()();
    expect(getAccessToken()).toBeNull(); // 사람은 즉시 나간다
    server.releaseRotation();
    await rotation;
    await waitFor(() =>
      expect(calls.some(call => call.path === LOGOUT_PATH)).toBe(true),
    );

    // 한 번에 비교해 RED 가 서버 상태 전체를 보여 주게 한다.
    expect({
      logoutAuthorization: calls.find(call => call.path === LOGOUT_PATH)
        ?.authorization,
      liveRefreshTokens: server.liveRefreshTokens(),
      registrationLive: server.state.registrationLive,
    }).toEqual({
      logoutAuthorization: 'Bearer access-token-2',
      liveRefreshTokens: [], // 서버에 산 세션(P2)이 남지 않는다
      registrationLive: false,
    });
    expect(getAccessToken()).toBeNull(); // 회전 결과가 세션을 되살리지 않는다
  });

  it('QR 연결 폰: 회전이 옛 access를 죽여도 DELETE는 새 access로 가고 등록이 끝난다 (REVIEW-GAP-B-linked)', async () => {
    store.set(NON_SECRET_KEYS.pushDeviceId, DEVICE);
    const server = fakeServer({linked: true});

    const rotation = refreshSessionOutcome();
    signOutFromApp()();
    expect(getAccessToken()).toBeNull();
    server.releaseRotation();
    await rotation;
    await waitFor(() =>
      expect(calls.some(call => call.path === LOGOUT_PATH)).toBe(true),
    );

    expect({
      deleteAuthorization: calls.find(call => call.method === 'DELETE')
        ?.authorization,
      deleteStatus: server.state.deleteStatus,
      registrationLive: server.state.registrationLive,
      liveRefreshTokens: server.liveRefreshTokens(),
    }).toEqual({
      deleteAuthorization: 'Bearer access-token-2',
      deleteStatus: 200,
      registrationLive: false,
      liveRefreshTokens: [],
    });
    expect(getAccessToken()).toBeNull();
  });
});

describe('로그아웃 — 기기 등록 삭제를 기다린다 (#2677 리뷰 L4)', () => {
  it('DELETE가 끝나기 전에는 POST /v1/auth/logout이 없다', async () => {
    store.set(NON_SECRET_KEYS.pushDeviceId, DEVICE);
    const gate = deferred<void>();
    globalThis.fetch = jest.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const call = record(input, init);
        if (call.method === 'DELETE') await gate.promise;
        return jsonResponse({status: 'ok'});
      },
    ) as unknown as typeof fetch;

    signOutFromApp()();
    await waitFor(() =>
      expect(calls.some(call => call.method === 'DELETE')).toBe(true),
    );
    await new Promise(settle => setTimeout(settle, 50));
    expect(calls.some(call => call.path === LOGOUT_PATH)).toBe(false);

    gate.resolve();
    await waitFor(() =>
      expect(calls.some(call => call.path === LOGOUT_PATH)).toBe(true),
    );
  });
});

describe('로그아웃 — 기기 등록 삭제에는 짧은 deadline (#2677 리뷰 L6)', () => {
  /** 이 폰이 서버 로그아웃을 늦출 수 있는 최대 시간. devices.ts 의 근거를 본다. */
  const DELETE_DEADLINE_MS = 4_000;

  afterEach(() => {
    jest.useRealTimers();
  });

  it('DELETE가 응답하지 않아도 서버 로그아웃은 4초 안에 간다', async () => {
    store.set(NON_SECRET_KEYS.pushDeviceId, DEVICE);
    jest.useFakeTimers();
    globalThis.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const call = record(input, init);
      if (call.method === 'DELETE') {
        // A request that never answers: it ends only when its deadline aborts it.
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        });
      }
      return Promise.resolve(jsonResponse({status: 'ok'}));
    }) as unknown as typeof fetch;

    signOutFromApp()();
    await jest.advanceTimersByTimeAsync(DELETE_DEADLINE_MS - 1);
    expect(calls.some(call => call.method === 'DELETE')).toBe(true);
    expect(calls.some(call => call.path === LOGOUT_PATH)).toBe(false);

    await jest.advanceTimersByTimeAsync(2);
    expect(calls.some(call => call.path === LOGOUT_PATH)).toBe(true);
  });
});
