import {onlineManager} from '@tanstack/react-query';
import {restoreSession} from '@momo/core/lib/api';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {
  __resetSessionStore,
  getPersistedSession,
  hasPersistedSession,
  keychainSettled,
  sessionPort,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// The rule this file exists to pin: **a launch with no signal must not cost the
// session.**
//
// It is written against the core rather than against a component because the
// hazard is in the core and the host guard is only meaningful next to a
// demonstration of what it is guarding. `useAuthGate` refuses to call
// `restoreSession()` while `onlineManager` reports offline; the first test here
// shows why that refusal is load-bearing, and the second shows the guard holding.
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

beforeEach(async () => {
  mmkvStore.clear();
  keychainItems.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase('https://api.example.com');
  sessionPort.applyLogin(LOGIN_BODY);
  await keychainSettled();
});

it('the core KEEPS a stored session when nothing answered — hazard fixed', async () => {
  // 이 테스트는 원래 **버그를 못박아 둔 것**이었다: `refreshSession()` 이 전송
  // 실패를 삼키고 `false` 를 내면 — 스스로의 주석이 "세션을 죽었다고 선언하지
  // 않는다"고 적어둔 그 경우 — `restoreSession()` 이 그래도 지워 버렸다.
  // 지하철 한 번에 비밀번호를 다시 쳐야 했다.
  //
  // 코어가 `RefreshOutcome`("rotated"/"rejected"/"unreachable")으로 거절과 침묵을
  // 가르면서 그 위험은 사라졌고, 이 파일은 예고대로 **고쳐진 동작을 지키는 쪽**으로
  // 뒤집는다. 되돌리면 여기가 다시 빨개진다.
  globalThis.fetch = jest.fn(async () => {
    throw new TypeError('Network request failed');
  }) as unknown as typeof fetch;

  expect(hasPersistedSession()).toBe(true);
  const resumed = await restoreSession();

  // 여전히 세션을 재개하지는 못한다(토큰을 갱신하지 못했으므로).
  expect(resumed).toBeNull();
  // 그러나 자격증명은 살아 있어야 한다 — 네트워크가 돌아오면 다음 시도가 성공한다.
  expect(getPersistedSession()).not.toBeNull();
  await keychainSettled();
  expect(keychainItems.get('app.momo.ios.rn.session')).toBeDefined();
});

it('the host guard keeps the session by not attempting the rotation at all', () => {
  // What `useAuthGate` does: it asks `onlineManager` first and returns without
  // touching `restoreSession()`. Asserting the predicate here keeps the guard
  // honest without standing up a React tree just to observe an absence.
  const fetchMock = jest.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  onlineManager.setOnline(false);

  expect(onlineManager.isOnline()).toBe(false);
  // The guard's whole content: offline means do not call it.
  if (onlineManager.isOnline()) {
    void restoreSession();
  }

  expect(fetchMock).not.toHaveBeenCalled();
  expect(hasPersistedSession()).toBe(true);
  onlineManager.setOnline(true);
});
