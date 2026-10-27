import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {Member, RosterMember} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, render} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {ThemeProvider} from '../src/design/theme';
import {SettingsPage} from '../src/features/profile/SettingsPage';
import {workspaceKeys} from '../src/features/workspace/queries';
import {notificationRulesKey} from '../src/features/profile/selfStatus';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// #4457 — 설정 페이지가 열려 있는 동안 지난 기한을 서버에 다시 묻는다 (design-review H3).
//
// 방해 금지·알림 일시 중지의 만료는 서버가 판정하고 이벤트를 보내지 않는다. 가만두면 지난 시각을
// 「…까지」로 말하는 줄이 설정 페이지에 남는다. 이 시험은 **페이지를 홀로** 세운다 — 셸 없이. 홈의
// `PauseBanner` 도 같은 훅(`useRecheckWhenElapsed`)을 돌리므로 셸 안에서 재면 페이지의 훅이 빠져도
// 배너가 대신 물어 시험이 구분하지 못한다(`profilePauseUntil.test.tsx` 가 셸 전체의 약속을 지고, 이
// 파일이 페이지 자신의 약속을 진다).
// =============================================================================

// 이 시험의 관심은 기한 재조회 하나다 — 네이티브·입출력에 기대는 다른 훅(푸시·기기 키·업데이트·기억)은
// 가짜로 바꾼다(`settingsAvatar.test.tsx` 와 같은 대역). `selfStatus` 는 **진짜**다(재조회 훅이 그것이다).
jest.mock('../src/push/usePushSwitch', () => ({
  PUSH_SWITCH_LABEL: '푸시 알림',
  PUSH_SWITCH_OFF_FAILED: 'x',
  pushSwitchDetail: () => '',
  usePushSwitch: () => ({
    on: false,
    busy: false,
    permission: 'granted',
    toggle: () => {},
    failed: false,
  }),
}));
jest.mock('../src/features/deviceKey/useDeviceKey', () => ({
  useDeviceKey: () => ({view: {kind: 'unavailable'}}),
}));
jest.mock('../src/features/deviceKey/copy', () => ({
  ...jest.requireActual('../src/features/deviceKey/copy'),
  deviceKeyCopy: () => ({badge: '연결 안 됨', detail: ''}),
}));
jest.mock('../src/features/appUpdate/useAppUpdateOffer', () => ({
  useAppUpdateOffer: () => null,
}));
jest.mock('../src/features/memory/MemoryPauseSection', () => ({MemoryPauseSection: () => null}));
jest.mock('../src/features/inbox/useOnline', () => ({useOnline: () => true}));

const WS = '33333333-3333-4333-8333-333333333333';
const ME = '44444444-4444-4444-8444-444444444444';
const BASE = 'https://api.example.com';

const SELF: Member = {
  id: ME,
  workspaceId: WS,
  kind: 'human',
  displayName: '이도현',
  handle: 'dohyun',
};

const NOW = Date.now();
const HOUR = 60 * 60_000;

function row(over: Partial<RosterMember>): RosterMember {
  return {
    ...SELF,
    status: 'active',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    presenceStatus: 'dnd',
    ...over,
  } as unknown as RosterMember;
}

function jsonResponse(body: unknown): Response {
  return {status: 200, ok: true, text: async () => JSON.stringify(body)} as unknown as Response;
}

let client: QueryClient | null = null;

function mount(self: RosterMember) {
  client = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {retry: false, gcTime: 0}},
  });
  return render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <SettingsPage
          workspaceId={WS}
          member={SELF}
          directory={makeDirectory([self])}
          connected
          onSignOut={() => {}}
          onClose={() => {}}
        />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

const asked = (spy: jest.SpyInstance) =>
  spy.mock.calls.map(call => JSON.stringify((call[0] as {queryKey: unknown}).queryKey));
const ROSTER_KEY = JSON.stringify(workspaceKeys.roster(WS));
const RULES_KEY = JSON.stringify(notificationRulesKey(WS));

beforeEach(() => {
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin({
    accessToken: 'access-token-1',
    refreshToken: 'refresh-token-1',
    realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
    member: SELF,
  });
  globalThis.fetch = jest.fn(async () => jsonResponse({})) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  client?.clear();
  client = null;
  jest.restoreAllMocks();
});

describe('설정 페이지는 알고 있는 기한이 지나면 서버에 다시 묻는다', () => {
  it('지난 방해 금지 기한이 있으면 규칙과 명부를 다시 읽는다', async () => {
    const invalidate = jest.spyOn(QueryClient.prototype, 'invalidateQueries');
    mount(row({dndUntilMs: NOW - HOUR}));
    await act(async () => {});
    expect(asked(invalidate)).toContain(ROSTER_KEY);
    expect(asked(invalidate)).toContain(RULES_KEY);
  });

  it('기한이 아직 오지 않았으면 묻지 않는다', async () => {
    const invalidate = jest.spyOn(QueryClient.prototype, 'invalidateQueries');
    mount(row({dndUntilMs: NOW + HOUR}));
    await act(async () => {});
    expect(asked(invalidate)).not.toContain(ROSTER_KEY);
    expect(asked(invalidate)).not.toContain(RULES_KEY);
  });

  it('기한이 없는 행(옛 판이 만든 것)은 만료가 없으니 묻지 않는다', async () => {
    const invalidate = jest.spyOn(QueryClient.prototype, 'invalidateQueries');
    mount(row({}));
    await act(async () => {});
    expect(asked(invalidate)).not.toContain(ROSTER_KEY);
  });
});
