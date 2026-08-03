import {onlineManager} from '@tanstack/react-query';
import {act, cleanup, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';
import {Text} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {useAuthGate} from '../src/session/useSession';
import {
  __resetSessionStore,
  getPersistedSession,
  hasPersistedSession,
  initSessionStore,
  keychainSettled,
  sessionPort,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// 서버에 못 닿는 시작이 **로그인 화면을 띄우지 않는다.**
//
// `restoreOffline.test.ts` 는 그 옆의 절반을 지킨다: 자격증명이 살아남는가.
// 이 파일은 나머지 절반이다 — **살아남은 다음 어떤 화면이 뜨는가.** 둘은 같이
// 틀릴 수 있고, 실제로 같이 틀렸다: 코어가 전송 실패에 더 이상 throw 하지
// 않게 되면서 자격증명은 살아남았고(고침), 그 throw 를 듣고 있던 호스트의
// `.catch` 가 영영 돌지 않게 되면서 게이트는 `signedOut` 으로 흘러내렸다.
// 자격증명은 그대로인데 화면은 비밀번호를 다시 물었다.
//
// ## 왜 순수 함수 테스트(`authGate.test.ts`)로는 못 잡는가
//
// `authGate()` 는 이미 옳았다. `restoreUnreachable: true` 를 주면 정확히
// `restoring/unreachable` 을 돌려준다 — 그 파일이 그것을 못박고 있다. 틀린 것은
// **그 사실이 어디서 오는가**였고, 그것은 훅 안의 약속 분기라 훅을 돌려야만
// 보인다. 그래서 여기서는 진짜 `useAuthGate` 를 마운트하고, 진짜 코어 회전을
// 돌리고, `fetch` 만 실기기가 겪는 방식으로 실패시킨다.
//
// 시뮬레이터 게이트(`npm run gate:session`, `restore-offline` 단계)가 같은 것을
// **진짜 재실행**으로 다시 묻는다. 이 파일은 그 게이트를 대신하지 않는다 —
// 게이트를 돌리기 전에 빨개지는 자리를 하나 앞에 둘 뿐이다.
// =============================================================================

const LOGIN_BODY = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    kind: 'human' as const,
    displayName: 'Seongjae Kwak',
    handle: 'seongjae',
  },
};

const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;
const keychainItems = (
  jest.requireMock('react-native-keychain') as {
    __items: Map<string, {password: string}>;
  }
).__items;

function Probe(): React.JSX.Element {
  const {gate} = useAuthGate();
  return (
    <>
      <Text testID="kind">{gate.kind}</Text>
      <Text testID="detail">
        {gate.kind === 'restoring'
          ? String(gate.unreachable)
          : gate.kind === 'signedOut'
            ? String(gate.expired)
            : gate.member.handle}
      </Text>
    </>
  );
}

/**
 * A RELAUNCH, not a fresh sign-in.
 *
 * The distinction is the whole subject: a stored session hydrates its member
 * from MMKV and its refresh token from the keychain, and has **no access token**
 * until one rotation mints one (ADR-0137 D7). Calling `applyLogin` and stopping
 * there would leave a live access token in memory, the gate would answer
 * `signedIn` before any of this ran, and the test would pass without ever
 * reaching the branch it exists to check.
 */
async function relaunchWithStoredSession(): Promise<void> {
  mmkvStore.clear();
  keychainItems.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase('https://api.example.com');
  sessionPort.applyLogin(LOGIN_BODY);
  await keychainSettled();
  // New process: memory forgotten, disk kept.
  __resetSessionStore();
  await initSessionStore();
}

beforeEach(async () => {
  onlineManager.setOnline(true);
  await relaunchWithStoredSession();
});

afterEach(() => {
  cleanup();
});

it('nothing answered — the screen says so and keeps the session', async () => {
  // What a launch on a plane, or against a server that is down, actually does:
  // the socket never opens and `fetch` rejects. The device still believes it has
  // a radio, so the host's offline short-circuit does NOT fire — this is the
  // path that reaches the core and reads its verdict.
  globalThis.fetch = jest.fn(async () => {
    throw new TypeError('Network request failed');
  }) as unknown as typeof fetch;

  render(<Probe />);

  // `unreachable` 을 기다린다 — `kind === 'restoring'` 만 기다리면 **회전이 아직
  // 날고 있는 첫 렌더**가 그것을 만족시켜서, 정착 뒤에 `signedOut` 으로
  // 흘러내리는 바로 그 결함을 통과시킨다. 이 문자열은 정착해야만 참이 된다.
  await waitFor(() => {
    expect(screen.getByTestId('detail').props.children).toBe('true');
  });
  // 로그인 화면이 아니라 「서버에 닿지 못했습니다」 + 다시 시도.
  expect(screen.getByTestId('kind').props.children).toBe('restoring');
  // 그리고 세션은 그대로다 — 다음 시도가 성공할 수 있어야 한다.
  expect(hasPersistedSession()).toBe(true);
  expect(getPersistedSession()).not.toBeNull();
  await keychainSettled();
  expect(keychainItems.get('app.momo.ios.rn.session')).toBeDefined();
});

it('a REFUSED token still ends the session — the fix did not blunt that', async () => {
  // The mirror case, and the reason the two must be told apart at all: a server
  // that answers 401 has proven the session is over. Keeping the person inside a
  // session the server has already ended would be the same lie in the other
  // direction, and it is the failure a coarse "never sign out" fix would ship.
  globalThis.fetch = jest.fn(async () => ({
    ok: false,
    status: 401,
    text: async () => '{"error":{"message":"invalid refresh token"}}',
  })) as unknown as typeof fetch;

  render(<Probe />);

  await waitFor(() => {
    expect(screen.getByTestId('kind').props.children).toBe('signedOut');
  });
  await act(async () => {
    await keychainSettled();
  });
  expect(hasPersistedSession()).toBe(false);
  expect(getPersistedSession()).toBeNull();
  expect(keychainItems.get('app.momo.ios.rn.session')).toBeUndefined();
});

it('a rotation that lands signs the person in', async () => {
  // The happy path, kept beside the other two so that "never shows the sign-in
  // form" cannot be satisfied by a hook that never resolves at all.
  globalThis.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        accessToken: 'access-token-2',
        refreshToken: 'refresh-token-2',
      }),
  })) as unknown as typeof fetch;

  render(<Probe />);

  await waitFor(() => {
    expect(screen.getByTestId('kind').props.children).toBe('signedIn');
  });
  expect(screen.getByTestId('detail').props.children).toBe('seongjae');
});
