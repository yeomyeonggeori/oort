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
