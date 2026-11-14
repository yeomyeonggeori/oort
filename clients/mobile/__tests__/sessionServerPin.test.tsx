import {refreshSessionOutcome, restoreSession} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';
import {Linking} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import ConnectScreen from '../src/screens/ConnectScreen';
import {SessionProvider, useSession} from '../src/session/useSession';
import {__setNonSecretStore, NON_SECRET_KEYS} from '../src/storage/kv';
import {
  __resetSessionStore,
  getAccessToken,
  getRefreshToken,
  initSessionStore,
  keychainSettled,
  sessionPort,
} from '../src/storage/secureSession';
import {
  __resetServerBaseCache,
  getServerBase,
  setServerBase,
} from '../src/storage/serverBase';

// =============================================================================
// #5816 — 인증 값이 실린 요청은 그 값을 내준 서버로만 가고, 링크로 받은 세션은 그 세션을 내준 서버
// 아래에서만 받아들인다. 실제 폰 저장소와 실제 화면으로 잰다. 서버 A의 값은 이름에 `-A`가 든다.
// =============================================================================

const A = 'https://a.example.com';
const B = 'https://b.example.com';
const WS = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const MEMBER = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: WS,
  kind: 'human' as const,
  displayName: '김도현',
  handle: 'dohyeon',
};
const SESSION_OF_A = {
  accessToken: 'access-A1',
  refreshToken: 'refresh-A1',
  realtimeWebSocketUrl: 'wss://a.example.com/connection/websocket',
  member: MEMBER,
};

interface Call {
  origin: string;
  method: string;
  path: string;
  carriesA: boolean;
}

let calls: Call[];

/** A가 내준 값이 A 밖으로 실려 간 요청. */
const leaksOfA = () =>
  calls.filter(call => call.origin !== A && call.carriesA).map(call => `${call.method} ${call.origin}${call.path}`);

function memoryStore() {
  const map = new Map<string, string>();
  return {
    map,
    getString: (key: string) => map.get(key),
    set: (key: string, value: string) => void map.set(key, String(value)),
    remove: (key: string) => map.delete(key),
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {'Content-Type': 'application/json'},
  });
}

type Route = (
  call: Call,
  signal: AbortSignal | undefined,
) => Promise<Response | undefined> | Response | undefined;

/** 요청을 적고, 맞는 길이 있으면 그 답을, 없으면 200을 준다. */
function stubFetch(route: Route): void {
  globalThis.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get('Authorization') ?? '';
    const body = typeof init?.body === 'string' ? init.body : '';
    const call = {
      origin: url.origin,
      method: init?.method ?? 'GET',
      path: url.pathname,
      carriesA: /-A\d/.test(auth) || /-A\d/.test(body),
    };
    calls.push(call);
    return (await route(call, init?.signal ?? undefined)) ?? jsonResponse({status: 'ok'});
  }) as unknown as typeof fetch;
}

/** 기한이 끊을 때까지 답하지 않는다. */
function never(signal: AbortSignal | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });
}

/** 앱이 실제로 쓰는 `signOut` 을 그 provider 에서 꺼내 온다. */
function signOutFromApp(): () => void {
  let captured: (() => void) | null = null;
  function Probe(): React.JSX.Element | null {
    captured = useSession().signOut;
    return null;
  }
  const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}});
  render(
    <QueryClientProvider client={client}>
      <SessionProvider member={MEMBER as never}>
        <Probe />
      </SessionProvider>
    </QueryClientProvider>,
  );
  if (captured === null) throw new Error('signOut 을 잡지 못했다');
  return captured;
}

const DEVICE_PATH = `/v1/workspaces/${WS}/devices/${DEVICE}`;
const LOGOUT_PATH = '/v1/auth/logout';

describe('로그아웃의 요청은 그 세션을 낸 서버로만 간다', () => {
  let store: ReturnType<typeof memoryStore>;

  beforeEach(async () => {
    store = memoryStore();
    __setNonSecretStore(store);
    __resetSessionStore();
    __resetServerBaseCache();
    setServerBase(A);
    sessionPort.applyLogin(SESSION_OF_A);
    await keychainSettled();
    store.set(NON_SECRET_KEYS.pushDeviceId, DEVICE);
    calls = [];
  });

  afterEach(() => {
    jest.useRealTimers();
    __setNonSecretStore(null);
  });

  it('푸시 등록 폐기와 로그아웃', async () => {
    jest.useFakeTimers();
    stubFetch((call, signal) =>
      call.method === 'DELETE' ? never(signal) : undefined,
    );
    signOutFromApp()();
    expect(getAccessToken()).toBeNull();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_500);
    });
    setServerBase(B);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_000);
    });
    expect(calls.map(call => `${call.method} ${call.origin}${call.path}`)).toEqual([
      `DELETE ${A}${DEVICE_PATH}`,
      `POST ${A}${LOGOUT_PATH}`,
    ]);
    expect(leaksOfA()).toEqual([]);
  });

  it('갱신에 합류한 로그아웃의 푸시 등록 폐기', async () => {
    let answerRefresh = () => {};
    const refreshAnswered = new Promise<void>(resolve => {
      answerRefresh = resolve;
    });
    stubFetch(async call => {
      if (call.path !== '/v1/auth/refresh') return undefined;
      await refreshAnswered;
      return jsonResponse({accessToken: 'access-A2', refreshToken: 'refresh-A2'});
    });
    const rotating = refreshSessionOutcome();
    await waitFor(() => expect(calls.some(call => call.path === '/v1/auth/refresh')).toBe(true));
    signOutFromApp()();
    setServerBase(B);
    answerRefresh();
    await rotating;
    await waitFor(() => expect(calls.some(call => call.path === LOGOUT_PATH)).toBe(true));
    expect(calls.map(call => `${call.method} ${call.origin}${call.path}`)).toEqual([
      `POST ${A}/v1/auth/refresh`,
      `DELETE ${A}${DEVICE_PATH}`,
      `POST ${A}${LOGOUT_PATH}`,
    ]);
    expect(leaksOfA()).toEqual([]);
  });
});

describe('세션이 저장된 채 서버 주소를 바꾸면 그 세션을 먼저 낸 서버에서 끝낸다', () => {
  beforeEach(async () => {
    __setNonSecretStore(memoryStore());
    __resetSessionStore();
    __resetServerBaseCache();
    setServerBase(A);
    calls = [];
    stubFetch(() => undefined);
  });

  afterEach(() => {
    __setNonSecretStore(null);
  });

  it('다음 서버로는 아무 값도 가지 않는다', async () => {
    sessionPort.applyLogin(SESSION_OF_A);
    await keychainSettled();
    setServerBase(B);
    expect(getAccessToken()).toBeNull();
    expect(getServerBase()).toBe(B);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls.map(call => `${call.method} ${call.origin}${call.path}`)).toEqual([`POST ${A}${LOGOUT_PATH}`]);
    expect(calls[0].carriesA).toBe(true);
    expect(leaksOfA()).toEqual([]);
  });

  it('같은 주소면 아무것도 하지 않는다', async () => {
    sessionPort.applyLogin(SESSION_OF_A);
    await keychainSettled();
    setServerBase(A);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls).toEqual([]);
    expect(getAccessToken()).toBe('access-A1');
  });

  it('세션이 없으면 주소만 바뀐다', async () => {
    setServerBase(B);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls).toEqual([]);
    expect(getServerBase()).toBe(B);
  });

  /** 앱을 다시 연다: 메모리를 잊고 저장소(메타데이터·키체인)에서 다시 읽는다. access 값은 메모리 전용이라 없다. */
  async function reopenWithSessionOfA(): Promise<void> {
    sessionPort.applyLogin(SESSION_OF_A);
    await keychainSettled();
    __resetSessionStore();
    await initSessionStore();
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBe('refresh-A1');
  }

  it('다시 연 뒤 refresh만 저장된 세션이어도 기기에서 끝나고, 뒤이은 복원은 다음 서버로 아무 값도 보내지 않는다', async () => {
    await reopenWithSessionOfA();
    stubFetch(call => (call.path === '/v1/auth/refresh' ? jsonResponse({error: {message: 'busy'}}, 503) : undefined));
    expect(await restoreSession()).toBeNull();
    expect(getRefreshToken()).toBe('refresh-A1');
    expect(calls.map(call => `${call.method} ${call.origin}${call.path}`)).toEqual([`POST ${A}/v1/auth/refresh`]);

    calls = [];
    stubFetch(call =>
      call.path === '/v1/auth/refresh' ? jsonResponse({accessToken: 'access-B1', refreshToken: 'refresh-B1'}) : undefined,
    );
    setServerBase(B);
    expect(getRefreshToken()).toBeNull();
    expect(getAccessToken()).toBeNull();
    // 다시 시도, 그리고 앱을 다시 연 뒤의 복원.
    expect(await restoreSession()).toBeNull();
    await keychainSettled();
    __resetSessionStore();
    await initSessionStore();
    expect(getRefreshToken()).toBeNull();
    expect(await restoreSession()).toBeNull();
    expect(calls.filter(call => call.origin === B)).toEqual([]);
    expect(leaksOfA()).toEqual([]);
  });

  it('다시 연 뒤 복원이 떠 있는 동안 바꾸면 그 복원이 받은 짝을 앞 서버에서 끝내고, 다음 서버로는 아무 값도 보내지 않는다', async () => {
    await reopenWithSessionOfA();
    let answerRefresh = () => {};
    const refreshAnswered = new Promise<void>(resolve => {
      answerRefresh = resolve;
    });
    stubFetch(async call => {
      if (call.path !== '/v1/auth/refresh') return undefined;
      await refreshAnswered;
      return jsonResponse({accessToken: 'access-A2', refreshToken: 'refresh-A2'});
    });
    const restoring = restoreSession();
    await waitFor(() => expect(calls.some(call => call.path === '/v1/auth/refresh')).toBe(true));
    setServerBase(B);
    expect(getRefreshToken()).toBeNull();
    answerRefresh();
    expect(await restoring).toBeNull();
    await waitFor(() => expect(calls.some(call => call.path === LOGOUT_PATH)).toBe(true));
    expect(calls.map(call => `${call.method} ${call.origin}${call.path}`)).toEqual([
      `POST ${A}/v1/auth/refresh`,
      `POST ${A}${LOGOUT_PATH}`,
    ]);
    expect(leaksOfA()).toEqual([]);
    expect(getRefreshToken()).toBeNull();
  });
});

// ---- 링크로 받은 세션 ---------------------------------------------------------

const C = 'https://c.example.com';
/** 일회용 링크 값(43자). */
const VOUCHER_A = 'a'.repeat(43);
const VOUCHER_C = 'c'.repeat(43);
const linkTo = (server: string, voucher: string) =>
  `oort://link?server=${encodeURIComponent(server)}&token=${voucher}`;

const mmkvStore = (jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}).__store;
const keychainItems = (
  jest.requireMock('react-native-keychain') as {__items: Map<string, {password: string}>}
).__items;
const KEYCHAIN_SESSION = 'app.momo.ios.rn.session';

describe('링크로 받은 세션은 그 세션을 내준 서버 아래에서만 받아들인다', () => {
  let emitUrl: (url: string) => void;

  beforeEach(() => {
    mmkvStore.clear();
    keychainItems.clear();
    __resetSessionStore();
    __resetServerBaseCache();
    calls = [];
    const listeners: ((event: {url: string}) => void)[] = [];
    jest
      .spyOn(Linking, 'addEventListener')
      .mockImplementation(((type: string, listener: (event: {url: string}) => void) => {
        if (type === 'url') listeners.push(listener);
        return {remove: () => {}};
      }) as never);
    emitUrl = url => {
      act(() => {
        for (const listener of listeners) listener({url});
      });
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('확인을 기다리는 세션은 낸 서버에만 묻고, 그 서버 아래에서만 켠다', async () => {
    jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(linkTo(A, VOUCHER_A));
    let confirmed = false;
    let answerC = () => {};
    const answeredC = new Promise<void>(resolve => {
      answerC = resolve;
    });
    stubFetch(async call => {
      if (call.path === '/v1/auth/device-link/redeem') {
        if (call.origin === A) {
          return jsonResponse({...SESSION_OF_A, pendingSas: true, sas: '4821'});
        }
        await answeredC; // C의 링크는 이 시험이 끝날 때까지 답하지 않는다
        return jsonResponse({error: {message: 'device link token is invalid'}}, 401);
      }
      if (call.path.startsWith('/v1/workspaces/')) {
        return confirmed
          ? jsonResponse({channels: []})
          : jsonResponse({error: {message: 'token has not been activated'}}, 401);
      }
      return undefined;
    });
    const view = render(<ConnectScreen />);
    await waitFor(() => expect(screen.getByTestId('device-link-sas')).toBeTruthy());

    emitUrl(linkTo(C, VOUCHER_C));
    await waitFor(() =>
      expect(calls.some(call => call.origin === C && call.path === '/v1/auth/device-link/redeem')).toBe(true),
    );
    expect(getServerBase()).toBe(C);
    confirmed = true;
    await waitFor(
      () => expect(calls.some(call => call.origin === A && call.path === LOGOUT_PATH)).toBe(true),
      {timeout: 6000},
    );
    await keychainSettled();
    expect(keychainItems.has(KEYCHAIN_SESSION)).toBe(false);
    expect(getAccessToken()).toBeNull();
    expect(calls.filter(call => call.path.startsWith('/v1/workspaces/')).map(call => call.origin)).not.toContain(C);
    expect(leaksOfA()).toEqual([]);
    answerC();
    await waitFor(() => expect(screen.getByTestId('device-link-failure')).toBeTruthy());
    view.unmount();
  }, 10000);

  it('늦게 끝난 링크는 그 뒤에 고른 서버를 되돌리지 않는다', async () => {
    mmkvStore.set('momo.mobile.server.v1', B);
    __resetServerBaseCache();
    jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(linkTo(A, VOUCHER_A));
    let answerA = () => {};
    const answeredA = new Promise<void>(resolve => {
      answerA = resolve;
    });
    stubFetch(async call => {
      if (call.path !== '/v1/auth/device-link/redeem') return undefined;
      if (call.origin === A) {
        await answeredA;
        return jsonResponse({...SESSION_OF_A, pendingSas: false});
      }
      return jsonResponse({
        accessToken: 'access-C1',
        refreshToken: 'refresh-C1',
        realtimeWebSocketUrl: 'wss://c.example.com/connection/websocket',
        member: MEMBER,
        pendingSas: false,
      });
    });
    const view = render(<ConnectScreen />);
    await waitFor(() =>
      expect(calls.some(call => call.origin === A && call.path === '/v1/auth/device-link/redeem')).toBe(true),
    );
    emitUrl(linkTo(C, VOUCHER_C));
    await waitFor(() => expect(getAccessToken()).toBe('access-C1'));
    answerA();
    await waitFor(() => expect(calls.some(call => call.origin === A && call.path === LOGOUT_PATH)).toBe(true));
    await keychainSettled();
    expect(getServerBase()).toBe(C);
    expect(getAccessToken()).toBe('access-C1');
    expect(keychainItems.get(KEYCHAIN_SESSION)?.password).toBe('refresh-C1');
    expect(leaksOfA()).toEqual([]);
    view.unmount();
  });
});
