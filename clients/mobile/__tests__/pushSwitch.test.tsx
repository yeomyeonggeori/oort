import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import * as Notifications from 'expo-notifications';
import React from 'react';
import {AppState, Linking} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {ThemeProvider} from '../src/design/theme';
import {SettingsContent} from '../src/features/profile/SettingsPage';
import {__setPermissionReader} from '../src/push/permissionStatus';
import PushProvider from '../src/push/PushProvider';
import {SessionProvider, useSession} from '../src/session/useSession';
import {NON_SECRET_KEYS} from '../src/storage/kv';
import {
  __resetSessionStore,
  keychainSettled,
  sessionPort,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// `PushProvider` 가 등록하려면 이 빌드가 APNs 환경을 말할 수 있어야 한다. 시험에서는
// 네이티브 모듈이 없어 늘 null 이고, 그러면 등록이 **시도되지 않아** 아래의 「재실행하면 POST
// 0」이 아무것도 재지 못한 채 통과한다. 그래서 환경을 준다.
jest.mock('../src/push/native', () => ({
  apnsEnvironment: () => 'sandbox',
  keychainAccessGroup: () => 'YWQQFQM38J.app.momo.ios.shared',
  pushNativeModuleAvailable: () => true,
  nativeApprovalHandlerAttached: () => false,
}));

// =============================================================================
// #3924 — 프로필 시트의 「푸시 알림」은 이 폰의 스위치다 (ADR-0204 D1).
//
// 성재(2026-10-16): 「푸시알림이 토글형태로 되어야 하고」. 이 파일이 못박는 것:
//   1. 켬 = OS 허용 + 사람이 끄지 않음. 켜져 있으면 이 기기를 서버에 등록한다.
//   2. 끄면 이 기기의 토큰만 서버에서 지우고(DELETE 1회), **앱을 다시 켜도 등록하지
//      않는다**(POST 0). 다시 켜면 등록한다.
//   3. OS 가 거부했으면 스위치가 iOS 설정을 연다. 아직 안 물었으면 허용 창을 띄운다.
//   4. 로그아웃하면 「껐다」는 기억이 지워진다. 다른 사람이 껐던 기억은 지금 사람을
//      막지 않는다.
//   5. 끄기가 서버에 닿지 못하면 스위치는 켜진 채로 그렇게 말한다 — 꺼졌다고 말하는데
//      서버가 계속 보내는 것이 이 줄이 낼 수 있는 가장 나쁜 답이다.
//   6. 등록이 날아가는 중에 껐거나, 실패한 등록이 포그라운드 재시도를 빚지고 있을 때
//      껐다면, 껐던 폰이 스스로 다시 등록하지 않는다.
//
// 서버 뒤는 fetch 하나만 가짜다. 요청은 전부 기록하고, 이 기기의 서버 쪽 상태(토큰이
// 살아 있는가)는 가짜가 **기억한다** — 「껐는데 서버에는 살아 있다」가 그 상태로 보이게.
// =============================================================================

// 이 파일의 첫 시험은 모듈 적재와 권한 읽기·토큰·등록의 연쇄를 한꺼번에 치른다 — 부하가 높은
// 기계에서 기본 1초는 모자란다. 기다림의 상한만 넓히고, 부정(「POST 0」)은 `settle()` 로 잰다.
configure({asyncUtilTimeout: 5000});
jest.setTimeout(20000);

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '99999999-9999-4999-8999-999999999999';
const BASE = 'https://api.example.com';

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

const DEVICES = `/v1/workspaces/${WS}/devices`;

const GRANTED = {
  granted: true,
  canAskAgain: true,
  status: 'granted',
  expires: 'never',
  ios: {status: 2},
};
const DENIED = {
  granted: false,
  canAskAgain: false,
  status: 'denied',
  expires: 'never',
  ios: {status: 1},
};
const UNDETERMINED = {
  granted: false,
  canAskAgain: true,
  status: 'undetermined',
  expires: 'never',
  ios: {status: 0},
};

const permissions = Notifications.getPermissionsAsync as jest.Mock;
const requestPermissions = Notifications.requestPermissionsAsync as jest.Mock;
const apnsToken = Notifications.getDevicePushTokenAsync as jest.Mock;

const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;

interface Call {
  method: string;
  path: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return {promise, resolve};
}

interface FakeServer {
  /** `POST /devices` 의 답 상태. 409 는 서버가 「다시 시도」라고 말하는 충돌이다. */
  registerStatus: number;
  /** `DELETE /devices/{id}` 의 답: 상태, 또는 망이 끊긴 것. */
  revokeStatus: number | 'network';
  /** 참이면 `access-token-1` 은 기기 경로에서 401 이다 — 15분이 지난 토큰. */
  staleAccess: boolean;
  /** 이 답이 풀리기 전에는 `POST /devices` 가 서버에 닿지 않은 것으로 친다. */
  holdRegister: Deferred | null;
  /** 이 기기의 토큰이 서버에서 살아 있는가. 등록이 켜고 DELETE 가 끈다. */
  tokenLive: boolean;
}

let calls: Call[];
let server: FakeServer;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json'},
  });
}

function installFetch(): void {
  // 이 시험의 기록에만 쓴다 — 시험이 끝난 뒤 늦게 도착하는 요청이 다음 시험의 기록에
  // 섞이면 안 된다(`calls` 변수는 시험마다 새 배열을 가리킨다).
  const log = calls;
  globalThis.fetch = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const authorization = new Headers(init?.headers).get('Authorization');
      const body =
        typeof init?.body === 'string' && init.body !== ''
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null;
      log.push({method, path: url.pathname, authorization, body});

      if (url.pathname === '/v1/auth/refresh') {
        return json(200, {
          accessToken: 'access-token-2',
          refreshToken: 'refresh-token-2',
        });
      }
      if (url.pathname.startsWith(DEVICES)) {
        if (server.staleAccess && authorization === 'Bearer access-token-1') {
          return json(401, {error: {message: 'token expired'}});
        }
        if (method === 'POST') {
          if (server.holdRegister) await server.holdRegister.promise;
          if (server.registerStatus >= 200 && server.registerStatus < 300) {
            server.tokenLive = true;
          }
          return json(server.registerStatus, {device: {id: body?.deviceId}});
        }
        if (method === 'DELETE') {
          if (server.revokeStatus === 'network') {
            throw new TypeError('Network request failed');
          }
          if (server.revokeStatus >= 200 && server.revokeStatus < 300) {
            server.tokenLive = false;
          }
          return json(server.revokeStatus, {
            device: {},
            invalidatedCount: server.revokeStatus === 200 ? 1 : 0,
            error: {message: 'x'},
          });
        }
      }
      if (url.pathname.endsWith('/notification-rules/push-kinds')) {
        return json(200, {workComplete: true});
      }
      if (url.pathname.endsWith('/notification-rules')) {
        return json(200, {dnd: false, mentionOverridesMute: false});
      }
      return json(200, {});
    },
  ) as unknown as typeof fetch;
}

const devicePosts = () =>
  calls.filter(call => call.method === 'POST' && call.path === DEVICES);
const deviceDeletes = () =>
  calls.filter(
    call => call.method === 'DELETE' && call.path.startsWith(`${DEVICES}/`),
  );
const mintedDeviceId = () => mmkvStore.get(NON_SECRET_KEYS.pushDeviceId);

/** `AppState` 전이를 손으로 낸다(RN jest mock 은 emit 이 없다). 렌더 전에 건다. */
function captureAppState(): (status: string) => Promise<void> {
  const handlers: ((status: string) => void)[] = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _event: string,
    fn: (status: string) => void,
  ) => {
    handlers.push(fn);
    return {
      remove: () => {
        const at = handlers.indexOf(fn);
        if (at >= 0) handlers.splice(at, 1);
      },
    };
  }) as never);
  return async status => {
    await act(async () => {
      for (const fn of [...handlers]) fn(status);
    });
  };
}

let signOut: () => void = () => {};

function Probe(): null {
  signOut = useSession().signOut;
  return null;
}

let queryClient: QueryClient | null = null;
let running: ReturnType<typeof render> | null = null;

/** 앱의 한 실행: 진짜 세션·진짜 `PushProvider`·진짜 프로필 알림 묶음. */
function launch() {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {retry: false, gcTime: 0},
      mutations: {retry: false, gcTime: 0},
    },
  });
  running = render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <SessionProvider member={SELF}>
          <PushProvider>
            <Probe />
            <SettingsContent
              workspaceId={WS}
              member={SELF}
              directory={makeDirectory([])}
              connected
              onOpenTheme={() => {}}
              onOpenStatus={() => {}}
              onOpenDeviceKey={() => {}}
              onOpenPauseUntil={() => {}}
              onOpenDndUntil={() => {}}
              onSignOut={() => signOut()}
              onRevealEnd={() => {}}
            />
          </PushProvider>
        </SessionProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return running;
}

/** 앱을 끄고 다시 켠다. 기기 저장소(MMKV)와 키체인은 그대로 남는다. */
function relaunch() {
  running?.unmount();
  queryClient?.clear();
  calls.length = 0;
  // 「새 실행이 권한을 읽었다」를 기다리는 시험이 앞 실행의 호출로 통과하지 않게.
  permissions.mockClear();
  return launch();
}

const row = () => screen.getByTestId('profile-push-row');
const rowState = () => row().props.accessibilityState;
const pushSwitch = () =>
  screen.getByTestId('profile-push-switch', {includeHiddenElements: true});

/** 비동기 연쇄(권한 읽기 → 토큰 → 등록)가 끝까지 갈 시간을 준다. */
async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 60));
  });
}

beforeEach(async () => {
  mmkvStore.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin(LOGIN_BODY);
  await keychainSettled();

  calls = [];
  server = {
    registerStatus: 201,
    revokeStatus: 200,
    staleAccess: false,
    holdRegister: null,
    tokenLive: false,
  };
  installFetch();

  permissions.mockReset();
  permissions.mockResolvedValue(GRANTED);
  requestPermissions.mockReset();
  requestPermissions.mockResolvedValue(GRANTED);
  signOut = () => {};
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  running = null;
  __setPermissionReader(null);
  jest.restoreAllMocks();
});

describe('켜져 있는 폰 — OS 허용 + 끈 적 없음', () => {
  it('스위치가 켜져 있고, 이 기기를 서버에 등록한다', async () => {
    launch();
    await waitFor(() => expect(devicePosts()).toHaveLength(1));

    expect(row().props.accessibilityRole).toBe('switch');
    expect(row().props.accessibilityLabel).toBe('푸시 알림');
    await waitFor(() =>
      expect(rowState()).toMatchObject({checked: true, disabled: false}),
    );
    expect(row()).toHaveTextContent(/이 폰으로 알림을 받아요\./);
    expect(pushSwitch().props.value).toBe(true);
    expect(devicePosts()[0].body).toMatchObject({
      deviceId: mintedDeviceId(),
      platform: 'ios',
      apnsToken: 'aabbcc',
      env: 'sandbox',
    });
    // 예전의 두 줄(알림 켜기·설정에서 알림 켜기)은 스위치가 대신한다.
    expect(screen.queryByTestId('profile-push-ask')).toBeNull();
    expect(screen.queryByTestId('profile-push-settings')).toBeNull();
  });

  it('OS 읽기가 끝나기 전에는 「꺼짐」을 그리지 않는다', async () => {
    permissions.mockImplementation(() => new Promise(() => {}));
    launch();

    await waitFor(() =>
      expect(screen.getByTestId('profile-push-loading', {includeHiddenElements: true})).toBeTruthy(),
    );
    expect(
      screen.queryByTestId('profile-push-switch', {includeHiddenElements: true}),
    ).toBeNull();
    expect(row()).toHaveTextContent(/확인하는 중이에요\./);
    expect(rowState()).toMatchObject({disabled: true});
    // 눌려도 아무 일도 없다 — 허용 창도, 서버 요청도, 기억도.
    fireEvent.press(row());
    await settle();
    expect(requestPermissions).not.toHaveBeenCalled();
    expect(deviceDeletes()).toHaveLength(0);
    expect(mmkvStore.has(NON_SECRET_KEYS.pushOptOut)).toBe(false);
  });
});

describe('끄기 — 이 기기만, 다시 켜기 전까지', () => {
  it('끄면 이 기기를 서버에서 한 번 지우고, 앱을 다시 켜도 등록하지 않는다 (DELETE 1 · 재실행 POST 0)', async () => {
    launch();
    await waitFor(() => expect(devicePosts()).toHaveLength(1));
    const id = mintedDeviceId();
    expect(id).toBeTruthy();
    expect(server.tokenLive).toBe(true);

    fireEvent.press(row());

    await waitFor(() => expect(deviceDeletes()).toHaveLength(1));
    expect(deviceDeletes()[0].path).toBe(`${DEVICES}/${id}`);
    expect(deviceDeletes()[0].authorization).toBe('Bearer access-token-1');
    await waitFor(() => expect(rowState()).toMatchObject({checked: false}));
    expect(pushSwitch().props.value).toBe(false);
    expect(row()).toHaveTextContent(
      /이 폰으로는 보내지 않아요\. 데스크탑 알림은 그대로예요\./,
    );
    expect(server.tokenLive).toBe(false);
    expect(mmkvStore.get(NON_SECRET_KEYS.pushOptOut)).toBe(SELF_ID);

    // ---- 앱을 다시 켠다 ----
    relaunch();
    await waitFor(() => expect(permissions).toHaveBeenCalled());
    await settle();

    expect(devicePosts()).toHaveLength(0);
    expect(deviceDeletes()).toHaveLength(0);
    expect(server.tokenLive).toBe(false);
    expect(rowState()).toMatchObject({checked: false});
    expect(row()).toHaveTextContent(/데스크탑 알림은 그대로예요/);

    // ---- 다시 켠다: 같은 실행에서 등록한다 ----
    fireEvent.press(row());
    await waitFor(() => expect(devicePosts()).toHaveLength(1));
    expect(devicePosts()[0].body).toMatchObject({deviceId: id});
    await waitFor(() => expect(rowState()).toMatchObject({checked: true}));
    expect(row()).toHaveTextContent(/이 폰으로 알림을 받아요\./);
    expect(mmkvStore.has(NON_SECRET_KEYS.pushOptOut)).toBe(false);
    expect(server.tokenLive).toBe(true);
  });

  it('껐다가 같은 실행에서 다시 켜도 등록한다 — 앱을 다시 켜지 않아도', async () => {
    launch();
    await waitFor(() => expect(devicePosts()).toHaveLength(1));

    fireEvent.press(row());
    await waitFor(() => expect(rowState()).toMatchObject({checked: false}));
    await waitFor(() => expect(deviceDeletes()).toHaveLength(1));
    expect(devicePosts()).toHaveLength(1);

    fireEvent.press(row());
    await waitFor(() => expect(devicePosts()).toHaveLength(2));
    await waitFor(() => expect(rowState()).toMatchObject({checked: true}));
    expect(server.tokenLive).toBe(true);
  });

  it('스위치 자체를 눌러도 같다', async () => {
    launch();
    await waitFor(() => expect(devicePosts()).toHaveLength(1));
    await waitFor(() => expect(rowState()).toMatchObject({checked: true}));

    fireEvent(pushSwitch(), 'valueChange', false);

    await waitFor(() => expect(deviceDeletes()).toHaveLength(1));
    await waitFor(() => expect(rowState()).toMatchObject({checked: false}));
  });

  it('끄는 동안에는 스위치가 잠기고 다시 눌러도 요청이 더 나가지 않는다', async () => {
    launch();
    await waitFor(() => expect(devicePosts()).toHaveLength(1));
    // DELETE 가 서버에 닿았지만 답이 오기 전의 순간을 만든다.
    const answer = deferred();
    const answered = globalThis.fetch as jest.Mock;
    const original = answered.getMockImplementation();
    answered.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'DELETE') await answer.promise;
        return original!(input, init);
      },
    );

    fireEvent.press(row());
    await waitFor(() => expect(rowState()).toMatchObject({disabled: true}));
    fireEvent.press(row());
    fireEvent(pushSwitch(), 'valueChange', true);
    answer.resolve();
    await waitFor(() => expect(rowState()).toMatchObject({disabled: false}));

    expect(deviceDeletes()).toHaveLength(1);
    expect(devicePosts()).toHaveLength(1);
  });
});

describe('끄기가 서버에 닿지 못하면 — 꺼졌다고 말하지 않는다', () => {
  it.each([
    ['서버가 거절했다(500)', 500],
    ['망이 끊겼다', 'network'],
  ] as const)(
    '%s: 기억을 되돌리고, 스위치는 켜진 채로 그렇게 말한다',
    async (_name, revokeStatus) => {
      launch();
      await waitFor(() => expect(devicePosts()).toHaveLength(1));
      await waitFor(() => expect(rowState()).toMatchObject({checked: true}));
      server.revokeStatus = revokeStatus;

      fireEvent.press(row());

      await waitFor(() =>
        expect(screen.getByTestId('push-failure')).toHaveTextContent(
          /이 폰의 알림을 끄지 못했어요\./,
        ),
      );
      expect(mmkvStore.has(NON_SECRET_KEYS.pushOptOut)).toBe(false);
      expect(rowState()).toMatchObject({checked: true, disabled: false});
      expect(server.tokenLive).toBe(true);

      // 다시 누르면 한 번 더 시도한다.
      server.revokeStatus = 200;
      fireEvent.press(row());
      await waitFor(() => expect(rowState()).toMatchObject({checked: false}));
      expect(screen.queryByTestId('push-failure')).toBeNull();
      expect(server.tokenLive).toBe(false);
    },
  );

  it('서버에 이 기기가 없다(404)면 끌 것이 없다 — 꺼진 것이다', async () => {
    launch();
    await waitFor(() => expect(devicePosts()).toHaveLength(1));
    await waitFor(() => expect(rowState()).toMatchObject({checked: true}));
    server.revokeStatus = 404;

    fireEvent.press(row());

    await waitFor(() => expect(rowState()).toMatchObject({checked: false}));
    expect(deviceDeletes()).toHaveLength(1);
    expect(screen.queryByTestId('push-failure')).toBeNull();
    expect(mmkvStore.get(NON_SECRET_KEYS.pushOptOut)).toBe(SELF_ID);
  });

  it('이 폰이 서버에 등록된 적 없으면 DELETE 도, 새 기기 id 도 없다', async () => {
    // 토큰을 못 받아 등록이 시도되지 않았다 — 스위치는 켜져 있지만 서버에는 이 폰이 없다.
    apnsToken.mockResolvedValueOnce({type: 'android', data: 'x'});
    launch();
    await waitFor(() => expect(rowState()).toMatchObject({checked: true}));
    await settle();
    expect(devicePosts()).toHaveLength(0);
    expect(mintedDeviceId()).toBeUndefined();

    fireEvent.press(row());

    await waitFor(() => expect(rowState()).toMatchObject({checked: false}));
    expect(deviceDeletes()).toHaveLength(0);
    // 끄는 일이 id 를 새로 만들면 다음 등록이 서버에 죽은 행을 하나 더 남긴다.
    expect(mintedDeviceId()).toBeUndefined();
    expect(mmkvStore.get(NON_SECRET_KEYS.pushOptOut)).toBe(SELF_ID);
  });

  it('access 토큰이 이미 죽었어도 한 번 회전하고 다시 보내 끈다', async () => {
    launch();
    await waitFor(() => expect(devicePosts()).toHaveLength(1));
    await waitFor(() => expect(rowState()).toMatchObject({checked: true}));
    server.staleAccess = true; // 시트를 열어 둔 채 15분이 지났다

    fireEvent.press(row());

    await waitFor(() => expect(rowState()).toMatchObject({checked: false}));
    expect(deviceDeletes().map(call => call.authorization)).toEqual([
      'Bearer access-token-1',
      'Bearer access-token-2',
    ]);
    expect(screen.queryByTestId('push-failure')).toBeNull();
    expect(server.tokenLive).toBe(false);
  });
});

describe('켜기 — 등록도 낡은 토큰을 한 번 회전한다', () => {
  it('껐던 폰을 켤 때 access 토큰이 죽었어도 등록한다', async () => {
    mmkvStore.set(NON_SECRET_KEYS.pushOptOut, SELF_ID);
    launch();
    await waitFor(() => expect(rowState()).toMatchObject({checked: false}));
    await settle();
    expect(devicePosts()).toHaveLength(0);
    server.staleAccess = true;

    fireEvent.press(row());

    await waitFor(() => expect(devicePosts()).toHaveLength(2));
    expect(devicePosts().map(call => call.authorization)).toEqual([
      'Bearer access-token-1',
      'Bearer access-token-2',
    ]);
    await waitFor(() => expect(server.tokenLive).toBe(true));
  });
});

describe('OS 가 막은 폰', () => {
  it('거부됐으면 스위치는 꺼져 있고, 누르면 iOS 설정을 연다(허용 창은 띄우지 않는다)', async () => {
    permissions.mockResolvedValue(DENIED);
    const openSettings = jest
      .spyOn(Linking, 'openSettings')
      .mockResolvedValue(undefined);
    launch();

    await waitFor(() =>
      expect(row()).toHaveTextContent(/iOS 설정에서 알림이 꺼져 있어요\./),
    );
    expect(rowState()).toMatchObject({checked: false});
    await settle();
    expect(devicePosts()).toHaveLength(0);

    await act(async () => {
      fireEvent.press(row());
    });

    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(requestPermissions).not.toHaveBeenCalled();
    expect(devicePosts()).toHaveLength(0);
    expect(deviceDeletes()).toHaveLength(0);
    expect(rowState()).toMatchObject({checked: false});
  });

  it('설정에서 허용하고 돌아오면 한 번 더 누르지 않아도 켜지고 등록한다', async () => {
    permissions.mockResolvedValue(DENIED);
    jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    // 껐던 사람이다. 설정으로 가는 탭이 곧 「켜겠다」이므로 그 탭이 기억을 지운다.
    mmkvStore.set(NON_SECRET_KEYS.pushOptOut, SELF_ID);
    const emit = captureAppState();
    launch();
    await waitFor(() =>
      expect(row()).toHaveTextContent(/iOS 설정에서 알림이 꺼져 있어요\./),
    );

    await act(async () => {
      fireEvent.press(row());
    });
    expect(mmkvStore.has(NON_SECRET_KEYS.pushOptOut)).toBe(false);

    permissions.mockResolvedValue(GRANTED);
    await emit('active');

    await waitFor(() => expect(devicePosts()).toHaveLength(1));
    await waitFor(() => expect(rowState()).toMatchObject({checked: true}));
  });

  it('아직 안 물었으면 누르는 것이 iOS 허용 창이다. 허용하면 켜지고 등록한다', async () => {
    permissions.mockResolvedValue(UNDETERMINED);
    requestPermissions.mockImplementation(async () => {
      permissions.mockResolvedValue(GRANTED);
      return GRANTED;
    });
    launch();

    await waitFor(() =>
      expect(row()).toHaveTextContent(/아직 허용 여부를 정하지 않았어요\./),
    );
    await settle();
    // 시트를 보는 것이 권한 요청이 되면 안 된다.
    expect(requestPermissions).not.toHaveBeenCalled();
    expect(rowState()).toMatchObject({checked: false});

    await act(async () => {
      fireEvent.press(row());
    });

    expect(requestPermissions).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(devicePosts()).toHaveLength(1));
    await waitFor(() => expect(rowState()).toMatchObject({checked: true}));
  });

  it('허용 창에서 거부하면 스위치는 꺼진 채로 설정 안내를 말한다', async () => {
    permissions.mockResolvedValue(UNDETERMINED);
    requestPermissions.mockImplementation(async () => {
      permissions.mockResolvedValue(DENIED);
      return DENIED;
    });
    launch();
    await waitFor(() =>
      expect(row()).toHaveTextContent(/아직 허용 여부를 정하지 않았어요\./),
    );

    await act(async () => {
      fireEvent.press(row());
    });

    await waitFor(() =>
      expect(row()).toHaveTextContent(/iOS 설정에서 알림이 꺼져 있어요\./),
    );
    expect(rowState()).toMatchObject({checked: false, disabled: false});
    expect(devicePosts()).toHaveLength(0);
  });
});

describe('껐다는 기억은 누구의 것이고 언제 지워지는가', () => {
  it('로그아웃하면 지워진다', async () => {
    launch();
    await waitFor(() => expect(devicePosts()).toHaveLength(1));
    fireEvent.press(row());
    await waitFor(() => expect(rowState()).toMatchObject({checked: false}));
    expect(mmkvStore.get(NON_SECRET_KEYS.pushOptOut)).toBe(SELF_ID);

    await act(async () => {
      signOut();
    });

    expect(mmkvStore.has(NON_SECRET_KEYS.pushOptOut)).toBe(false);
  });

  it('다른 사람이 껐던 폰이라도 지금 사람의 등록을 막지 않는다', async () => {
    mmkvStore.set(NON_SECRET_KEYS.pushOptOut, OTHER_ID);

    launch();

    await waitFor(() => expect(devicePosts()).toHaveLength(1));
    await waitFor(() => expect(rowState()).toMatchObject({checked: true}));
  });
});

describe('껐을 때 아직 진행 중이던 등록', () => {
  it('등록이 DELETE 뒤에 서버에 닿으면 그 등록을 다시 지운다', async () => {
    server.holdRegister = deferred();
    launch();
    // 요청은 나갔고 서버의 답은 아직이다 — 사람이 그 사이에 끈다.
    await waitFor(() => expect(devicePosts()).toHaveLength(1));
    await waitFor(() => expect(rowState()).toMatchObject({checked: true}));

    fireEvent.press(row());
    await waitFor(() => expect(deviceDeletes()).toHaveLength(1));
    await waitFor(() => expect(rowState()).toMatchObject({checked: false}));

    // 서버가 그 등록을 DELETE **뒤에** 받는다: 토큰이 다시 살아난다. 앱이 그것을 알고
    // 다시 지워야 스위치와 서버가 같은 말을 한다.
    server.holdRegister.resolve();

    await waitFor(() => expect(deviceDeletes()).toHaveLength(2));
    expect(server.tokenLive).toBe(false);
    expect(mmkvStore.get(NON_SECRET_KEYS.pushOptOut)).toBe(SELF_ID);
  });

  describe('실패한 등록이 빚진 포그라운드 재시도', () => {
    it('끄지 않았으면 포그라운드로 돌아올 때 다시 등록한다 — 이 시험이 재시도를 볼 수 있다는 대조군', async () => {
      server.registerStatus = 409; // 서버가 「다시 시도」라고 답하는 충돌
      const emit = captureAppState();
      launch();
      await waitFor(() => expect(devicePosts()).toHaveLength(2));

      await emit('active');

      // 포그라운드 재시도도 한 번의 `registerWithRetry` 다: 즉시 두 번 시도한다.
      await waitFor(() => expect(devicePosts()).toHaveLength(4));
    });

    it('껐다면 포그라운드로 돌아와도 껐던 폰을 다시 등록하지 않는다', async () => {
      server.registerStatus = 409;
      const emit = captureAppState();
      launch();
      await waitFor(() => expect(devicePosts()).toHaveLength(2));

      fireEvent.press(row());
      await waitFor(() => expect(deviceDeletes()).toHaveLength(1));
      await waitFor(() => expect(rowState()).toMatchObject({checked: false}));
      await emit('active');
      await settle();

      expect(devicePosts()).toHaveLength(2);
    });
  });
});

describe('측정 하네스의 자리', () => {
  it('OS 의 답을 정해 두면 시트가 그것을 읽는다 — 진짜 iOS 에 묻지 않는다', async () => {
    permissions.mockResolvedValue(GRANTED);
    __setPermissionReader(async () => ({granted: false, canAskAgain: false}));

    launch();

    await waitFor(() =>
      expect(row()).toHaveTextContent(/iOS 설정에서 알림이 꺼져 있어요\./),
    );
  });
});
