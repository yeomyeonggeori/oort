import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, configure, render, waitFor} from '@testing-library/react-native';
import * as Keychain from 'react-native-keychain';
import * as Notifications from 'expo-notifications';
import React from 'react';
import {AppState} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {
  PUSH_ACTION_KEYCHAIN_SERVICE,
  PUSH_ACTION_SESSION_ACCOUNT,
} from '../src/push/contract';
import {__setPermissionReader} from '../src/push/permissionStatus';
import PushProvider from '../src/push/PushProvider';
import {clearPushOptOut, setPushOptedOut} from '../src/push/pushOptOut';
import {SessionProvider, useSession} from '../src/session/useSession';
import {
  __resetSessionStore,
  keychainSettled,
  sessionPort,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

jest.mock('../src/push/native', () => ({
  apnsEnvironment: () => 'sandbox',
  keychainAccessGroup: () => 'YWQQFQM38J.app.momo.ios.shared',
  pushNativeModuleAvailable: () => true,
  nativeApprovalHandlerAttached: () => false,
}));

// =============================================================================
// #3931 — 잠금 화면 승인의 자격(`push_action` 토큰)이 폰에서 **언제 생기고, 언제 이어지고,
// 언제 사라지는가**. `PushProvider` 의 §2b 가 하는 일이고, 진짜 세션·진짜 프로바이더·진짜
// 키퍼 위에서 잰다. 가짜는 서버(fetch)와 OS 권한뿐이다.
//
//   - 푸시를 받는 폰(OS 허용 + 사람이 끄지 않음)에만 둔다. 권한을 **읽는 중**에는 지우지도
//     받지도 않는다 — 읽는 중에 지우면 실행마다 지웠다 받아 서버의 계열당 4개 상한을 태운다.
//   - 지난 실행이 놔 둔 것이 이 사람의 것이고 살아 있으면 새로 받지 않는다 (429 방지).
//   - 놓는 값은 서버가 내준 토큰이다. access 토큰이 키체인의 이 항목에 들어간 적은 없다.
//   - 푸시를 끄거나 OS 가 막으면, 로그아웃하면 지운다.
// =============================================================================

configure({asyncUtilTimeout: 5000});
jest.setTimeout(20000);

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '99999999-9999-4999-8999-999999999999';
const BASE = 'https://api.example.com';
const APP_ONLY = 'YWQQFQM38J.app.momo.ios.devicekey';
const HOUR = 3_600_000;

const SELF: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '곽성재',
  handle: 'seongjae',
};

const LOGIN_BODY = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: SELF,
};

const GRANTED = {granted: true, canAskAgain: true, status: 'granted', expires: 'never', ios: {status: 2}};
const DENIED = {granted: false, canAskAgain: false, status: 'denied', expires: 'never', ios: {status: 1}};

const permissions = Notifications.getPermissionsAsync as jest.Mock;

const keychain = Keychain as unknown as {
  __items: Map<string, {username: string; password: string; options: Record<string, unknown>}>;
  setGenericPassword: jest.Mock;
  resetGenericPassword: jest.Mock;
};

interface Call {
  method: string;
  path: string;
  authorization: string | null;
}

let calls: Call[];
let mintStatus: number;
let mintCount: number;
/** 서버가 내주는 만료 시각을 시험이 정한다(null 이면 지금 + 6시간). */
let mintExpiry: number | null;
let now: number;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json'},
  });
}

function installFetch(): void {
  const log = calls;
  globalThis.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    log.push({method, path: url.pathname, authorization: new Headers(init?.headers).get('Authorization')});
    if (url.pathname === '/v1/auth/push-action-token') {
      if (mintStatus !== 200) return json(mintStatus, {error: {message: 'no'}});
      mintCount += 1;
      return json(200, {
        token: `push-action-token-${mintCount}`,
        expiresAtMs: mintExpiry ?? Date.now() + 6 * HOUR,
        ttlSeconds: 21_600,
        workspaceId: WS,
      });
    }
    if (url.pathname === '/v1/auth/push-fetch-token') {
      return json(200, {
        token: 'push-fetch-token-1',
        expiresAtMs: Date.now() + 6 * HOUR,
        ttlSeconds: 21_600,
        workspaceId: WS,
      });
    }
    if (url.pathname.endsWith('/devices') && method === 'POST') {
      return json(201, {device: {}});
    }
    return json(200, {});
  }) as unknown as typeof fetch;
}

const mints = () =>
  calls.filter(call => call.method === 'POST' && call.path === '/v1/auth/push-action-token');
const stored = (): {actionToken: string; memberID: string; baseURL: string; workspaceID: string; expiresAtMs: number; ttlSeconds: number} | null => {
  const item = keychain.__items.get(PUSH_ACTION_KEYCHAIN_SERVICE);
  return item ? JSON.parse(item.password) : null;
};

let signOut: () => void = () => {};
function Probe(): null {
  signOut = useSession().signOut;
  return null;
}

let queryClient: QueryClient | null = null;
let running: ReturnType<typeof render> | null = null;

function launch(member: Member = SELF) {
  queryClient = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {retry: false, gcTime: 0}},
  });
  running = render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider member={member}>
        <PushProvider>
          <Probe />
        </PushProvider>
      </SessionProvider>
    </QueryClientProvider>,
  );
  return running;
}

/**
 * 앱 프로세스가 죽었다가 다시 뜬다. 키체인과 기기 저장소는 남는다.
 *
 * 프로세스가 **죽는** 것과 React 트리가 **내려가는** 것은 다른 사건이다: 죽은 프로세스는
 * 정리 함수를 하나도 부르지 않는다. 시험은 트리를 내려야 새로 띄울 수 있고, 내리면 로그아웃
 * 때 도는 정리(자격 지우기)가 돈다 — 그래서 내리기 전의 키체인을 잡아 두었다가 돌려놓는다.
 * 이것이 없으면 「다시 켜도 새로 받지 않는다」가 정리 함수가 지운 자리에서 헛돌며 실패한다.
 */
function relaunch() {
  const survivors = new Map(keychain.__items);
  running?.unmount();
  keychain.__items.clear();
  for (const [service, item] of survivors) keychain.__items.set(service, item);
  // 트리를 내리며 돈 정리(지우기 호출)는 죽은 프로세스가 하지 않았을 일이다 — 새 실행의 호출만 세도록.
  keychain.resetGenericPassword.mockClear();
  keychain.setGenericPassword.mockClear();
  queryClient?.clear();
  calls.length = 0;
  permissions.mockClear();
  return launch();
}

async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 80));
  });
}

const mmkvStore = (jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}).__store;

beforeEach(async () => {
  mmkvStore.clear();
  keychain.__items.clear();
  keychain.setGenericPassword.mockClear();
  keychain.resetGenericPassword.mockClear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin(LOGIN_BODY);
  await keychainSettled();

  calls = [];
  mintStatus = 200;
  mintCount = 0;
  mintExpiry = null;
  now = Date.now();
  installFetch();
  permissions.mockReset();
  permissions.mockResolvedValue(GRANTED);
  jest.spyOn(AppState, 'addEventListener').mockImplementation((() => ({remove: () => {}})) as never);
  signOut = () => {};
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  running = null;
  __setPermissionReader(null);
  clearPushOptOut();
  jest.restoreAllMocks();
});

describe('푸시를 받는 폰에는 자격을 둔다', () => {
  it('시작하면 한 번 받아 앱 전용 그룹에 놓는다 — access 토큰이 아니라 서버가 내준 토큰을', async () => {
    launch();

    await waitFor(() => expect(stored()).not.toBeNull());
    expect(mints()).toHaveLength(1);
    expect(mints()[0].authorization).toBe('Bearer access-token-1');
    expect(stored()).toMatchObject({
      actionToken: 'push-action-token-1',
      memberID: SELF_ID,
      workspaceID: WS,
      baseURL: BASE,
      ttlSeconds: 21_600,
    });
    expect(stored()!.expiresAtMs).toBeGreaterThan(now + 5 * HOUR);
    const [account, , options] = keychain.setGenericPassword.mock.calls.find(
      call => call[2]?.service === PUSH_ACTION_KEYCHAIN_SERVICE,
    )!;
    expect(account).toBe(PUSH_ACTION_SESSION_ACCOUNT);
    expect(options.accessGroup).toBe(APP_ONLY);
    // 이 항목의 어디에도 세션의 access·refresh 토큰이 없다.
    const raw = keychain.__items.get(PUSH_ACTION_KEYCHAIN_SERVICE)!.password;
    expect(raw).not.toContain('access-token-1');
    expect(raw).not.toContain('refresh-token-1');
  });

  it('남은 수명이 절반 위인 자격이 이미 놓여 있으면 다시 켜도 새로 받지 않는다 (계열당 4개 상한)', async () => {
    launch();
    await waitFor(() => expect(stored()).not.toBeNull());
    expect(mints()).toHaveLength(1);

    for (let launches = 0; launches < 6; launches += 1) {
      relaunch();
      await settle();
    }

    expect(mints()).toHaveLength(0);
    expect(stored()?.actionToken).toBe('push-action-token-1');
  });

  it('놓여 있던 자격의 남은 수명이 절반 아래이면 새로 받는다', async () => {
    launch();
    await waitFor(() => expect(stored()).not.toBeNull());
    // 4시간 쓴 토큰으로 만든다.
    const item = keychain.__items.get(PUSH_ACTION_KEYCHAIN_SERVICE)!;
    const payload = JSON.parse(item.password);
    payload.expiresAtMs = Date.now() + 2 * HOUR;
    item.password = JSON.stringify(payload);

    relaunch();

    await waitFor(() => expect(stored()?.actionToken).toBe('push-action-token-2'));
    expect(mints()).toHaveLength(1);
  });

  it('로그아웃 없이 사람이 바뀐 폰에서는 앞 사람의 자격을 지우고 새 사람의 것을 받는다', async () => {
    launch();
    await waitFor(() => expect(stored()).not.toBeNull());
    const item = keychain.__items.get(PUSH_ACTION_KEYCHAIN_SERVICE)!;
    item.password = JSON.stringify({...JSON.parse(item.password), memberID: OTHER_ID});
    keychain.resetGenericPassword.mockClear();

    relaunch();

    await waitFor(() => expect(stored()?.memberID).toBe(SELF_ID));
    expect(keychain.resetGenericPassword).toHaveBeenCalled();
    expect(stored()?.actionToken).toBe('push-action-token-2');
  });

  it('서버가 터무니없는 만료 시각을 줘도 놓는 일이 끊기지 않는다 (날짜로 바꾸다 던지지 않는다)', async () => {
    mintExpiry = 1e20; // `new Date(1e20).toISOString()` 은 RangeError 다.

    launch();

    await waitFor(() => expect(stored()).not.toBeNull());
    expect(stored()!.expiresAtMs).toBe(1e20);
    // 놓였다고 키퍼가 **안다** — 세션이 회전해도(15분마다) 다시 받지 않는다. 놓는 줄에서 던졌다면
    // 키퍼는 놓지 못한 것으로 알고 회전마다 새로 받아 서버의 계열당 4개 상한을 태운다.
    await settle();
    act(() => {
      sessionPort.applyLogin({...LOGIN_BODY, accessToken: 'access-token-2'});
    });
    await settle();
    expect(mints()).toHaveLength(1);
  });

  it.each([404, 429, 403, 409, 500])(
    '서버가 받기를 거절하면(%i) 아무것도 놓지 않는다 — 옛 서버에서도 앱은 조용하다',
    async status => {
      mintStatus = status;

      launch();
      await waitFor(() => expect(mints().length).toBeGreaterThanOrEqual(1));
      await settle();

      expect(stored()).toBeNull();
      expect(keychain.setGenericPassword.mock.calls.filter(call => call[2]?.service === PUSH_ACTION_KEYCHAIN_SERVICE)).toHaveLength(0);
    },
  );
});

describe('푸시를 받지 않는 폰에는 자격을 두지 않는다', () => {
  it('OS 가 막았으면 받지 않고, 놓여 있던 것은 지운다', async () => {
    launch();
    await waitFor(() => expect(stored()).not.toBeNull());
    permissions.mockResolvedValue(DENIED);
    calls.length = 0;

    relaunch();

    await waitFor(() => expect(stored()).toBeNull());
    await settle();
    expect(mints()).toHaveLength(0);
  });

  it('권한을 읽는 중에는 받지도 지우지도 않는다 — 놓여 있던 것이 그대로 남는다', async () => {
    launch();
    await waitFor(() => expect(stored()).not.toBeNull());
    keychain.resetGenericPassword.mockClear();
    permissions.mockImplementation(() => new Promise(() => {}));
    calls.length = 0;

    relaunch();
    await settle();

    expect(mints()).toHaveLength(0);
    expect(stored()?.actionToken).toBe('push-action-token-1');
    expect(
      keychain.resetGenericPassword.mock.calls.filter(call => call[0]?.service === PUSH_ACTION_KEYCHAIN_SERVICE),
    ).toHaveLength(0);
  });

  it('사람이 이 폰의 푸시를 끄면(스위치) 자격을 지우고, 앱을 다시 켜도 받지 않는다', async () => {
    launch();
    await waitFor(() => expect(stored()).not.toBeNull());

    act(() => setPushOptedOut(SELF_ID, true));

    await waitFor(() => expect(stored()).toBeNull());
    relaunch();
    await settle();
    expect(mints()).toHaveLength(0);
    expect(stored()).toBeNull();
  });

  it('끈 폰의 스위치를 다시 켜면 앱을 다시 켜지 않아도 새로 받는다', async () => {
    setPushOptedOut(SELF_ID, true);
    launch();
    await settle();
    expect(mints()).toHaveLength(0);

    act(() => setPushOptedOut(SELF_ID, false));

    await waitFor(() => expect(stored()?.actionToken).toBe('push-action-token-1'));
  });

  it('다른 멤버가 껐던 기억은 지금 사람의 자격을 막지 않는다', async () => {
    setPushOptedOut(OTHER_ID, true);

    launch();

    await waitFor(() => expect(stored()).not.toBeNull());
  });
});

describe('로그아웃하면 지운다', () => {
  it('signOut() 이 그 자리에서 지운다 — 트리가 내려가기를 기다리지 않는다', async () => {
    launch();
    await waitFor(() => expect(stored()).not.toBeNull());

    act(() => signOut());

    await waitFor(() => expect(stored()).toBeNull());
  });

  it('프로바이더가 내려갈 때 자격을 지운다 (알림 확장의 자격과 같은 순간)', async () => {
    launch();
    await waitFor(() => expect(stored()).not.toBeNull());
    keychain.resetGenericPassword.mockClear();

    running?.unmount();

    await waitFor(() => expect(stored()).toBeNull());
    expect(keychain.resetGenericPassword).toHaveBeenCalledWith({
      service: PUSH_ACTION_KEYCHAIN_SERVICE,
      accessGroup: APP_ONLY,
    });
  });
});
