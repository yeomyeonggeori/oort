import type {Member} from '@momo/core/lib/api';
import {FIXTURE_LIST, FIXTURE_WORKSPACE_ID} from '@momo/core/features/expressions/fixtures';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {__resetBackgroundStoreForTests} from '../src/design/background/store';
import {ThemeProvider} from '../src/design/theme';
import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';
import {pinReduceMotion} from './fixtures/reduceMotion';

// =============================================================================
// 대화가 열린 동안 판 뒤의 홈 목록은 화면 낭독에 닿지 않는다 (#5546, S12 검증 7c3 A-B3).
//
// 홈에서 연 대화는 셸 전체를 덮는 불투명한 판인데 VoiceOver 의 모달 경계가 아니다(탭 위에 바로 연 대화는 모달이 아니다). 그래서 판 뒤의
// 홈 목록 행·업데이트 단추·내 얼굴이 낭독 트리에 남아, 대화 안에서 첫 요소 앞으로 쓸면 보이지 않는 홈 행에 초점이 갔다. 셸은 이미 「층이
// 덮였다」 값 `covered` 로 크롬(탭바·＋)을 숨기고 있었고(`coveredProps`, #2714), 같은 한 쌍을 탭 판의 틀(`shell-tab-body`)에도 펼친다:
// iOS `accessibilityElementsHidden` + Android `importantForAccessibility="no-hide-descendants"`.
//
// 셸·화면은 전부 진짜이고 가짜는 서버 경계(`fetch`) 하나다. RNTL 의 기본 찾기는 낭독에서 빠진 요소를 찾지 않으므로 「기본 찾기 0 · 숨은 것까지
// 1」이 「마운트는 그대로, 낭독에서만 빠짐」을 잰다. 걷히면(홈으로 돌아오면) 다시 낭독에 들어와야 한다 — 빠진 채로 남는 것이 더 나쁜 결함이다.
// 시뮬레이터 접근성 계층(`maestro hierarchy`)의 같은 숫자는 PR 본문에 있다.
// =============================================================================

const WS = FIXTURE_WORKSPACE_ID;
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const PEER_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const GENERAL = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BASE = 'https://api.example.com';

const SELF: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '이도현',
  handle: 'dohyun',
};

const LOGIN_BODY = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: SELF,
};

function rosterMember(over: Record<string, unknown>) {
  return {
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    role: 'member',
    displayName: '이름',
    handle: 'handle',
    channelCount: 1,
    channelIds: [GENERAL],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

const ROSTER = [
  rosterMember({id: SELF_ID, displayName: '이도현', handle: 'dohyun', role: 'owner'}),
  rosterMember({id: PEER_ID, displayName: '박서연', handle: 'seoyeon'}),
];

const CHANNELS = [{id: GENERAL, workspaceId: WS, kind: 'public', name: 'general', muted: false}];

const HISTORY = [
  {
    id: 'msg-1',
    seq: 1,
    channelId: GENERAL,
    authorMemberId: PEER_ID,
    body: '배포는 금요일 오전 10시예요.',
    hlcTs: 1,
    hlcCount: 0,
    type: 'text',
    state: 'sent',
    createdAtMs: 1_700_000_001_000,
  },
];

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function installFetch(): void {
  globalThis.fetch = jest.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/channels')) return jsonResponse(200, {channels: CHANNELS});
    if (path.endsWith('/expressions')) return jsonResponse(200, {...FIXTURE_LIST, items: []});
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (/\/inbox(\/|$)/.test(path)) {
      return jsonResponse(404, {error: {code: 'not_found', message: 'not found'}});
    }
    if (url.includes('/roster')) return jsonResponse(200, {members: ROSTER});
    if (url.includes('/read-state')) return jsonResponse(200, {read_states: []});
    if (url.includes('/messages')) return jsonResponse(200, {messages: HISTORY});
    if (url.includes('/approvals')) return jsonResponse(200, {approvals: []});
    return jsonResponse(404, {error: {code: 'not_found', message: 'not found'}});
  }) as unknown as typeof fetch;
}

let queryClient: QueryClient | null = null;

function renderShell() {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {retry: false, gcTime: 0},
      mutations: {retry: false, gcTime: 0},
    },
  });
  return render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AppShell member={SELF} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

const mmkvStore = (jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}).__store;

let releaseMotion: (() => void) | null = null;

beforeEach(async () => {
  releaseMotion = await pinReduceMotion(true);
  mmkvStore.clear();
  __resetBackgroundStoreForTests();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin(LOGIN_BODY);
  installFetch();
});

afterEach(() => {
  cleanup();
  releaseMotion?.();
  releaseMotion = null;
  queryClient?.clear();
  queryClient = null;
  jest.restoreAllMocks();
});

/** 낭독에서 빠진 요소까지 찾는다 — 「마운트는 그대로인가」를 잴 때만 쓴다. */
const HIDDEN = {includeHiddenElements: true} as const;
const tabBody = () => screen.getByTestId('shell-tab-body', HIDDEN);
/** 판 뒤에 남으면 안 되는 홈의 이름 있는 컨트롤(판정 A-B3 이 계층에서 센 것). 업데이트 띠는 버전 끝점을 흉내 내지 않아 시뮬레이터 계층으로 잰다. */
const HOME_CONTROLS = ['profile-avatar', `sidebar-row-channel:${GENERAL}`, 'sidebar-list'] as const;

/** 층이 없는 홈: 탭 판 틀은 아무것도 펼치지 않고(두 속성 모두 없음), 홈 컨트롤은 기본 찾기로 닿는다. */
function expectHomeReachable() {
  for (const id of HOME_CONTROLS) {
    expect([id, screen.queryAllByTestId(id).length]).toEqual([id, 1]);
  }
  expect(tabBody().props.accessibilityElementsHidden).toBeUndefined();
  expect(tabBody().props.importantForAccessibility).toBeUndefined();
}

describe('대화가 열린 동안 판 뒤의 홈 목록은 화면 낭독에서 빠진다 (#5546)', () => {
  it('대화를 열면 탭 판이 두 플랫폼 모두에서 빠져 홈 컨트롤이 닿지 않고, 뒤로 돌아오면 다시 닿는다', async () => {
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId(`sidebar-row-channel:${GENERAL}`)).toBeTruthy());
    expectHomeReachable();

    fireEvent.press(screen.getByTestId(`sidebar-row-channel:${GENERAL}`));
    await screen.findByTestId('conversation-title');

    // 탭 위에 바로 연 대화는 모달이 아니다 — 판 뒤 탭 판을 빼는 것은 모달 형제 규칙이 아니라 틀의 한 쌍이다.
    expect(screen.getByTestId('conversation-pane')).toHaveProp('accessibilityViewIsModal', false);
    // 홈 컨트롤은 마운트된 채(스크롤 자리 보존) 낭독에서만 빠진다.
    for (const id of HOME_CONTROLS) {
      expect([id, screen.queryAllByTestId(id, HIDDEN).length]).toEqual([id, 1]);
      expect([id, screen.queryAllByTestId(id).length]).toEqual([id, 0]);
    }
    // 두 플랫폼의 한 쌍이 모두 선다 — RNTL 의 기본 찾기는 둘 중 하나만 있어도 빼므로 Android 쪽은 속성으로 따로 잰다.
    expect(tabBody().props.accessibilityElementsHidden).toBe(true);
    expect(tabBody().props.importantForAccessibility).toBe('no-hide-descendants');
    // 대화 자신은 그대로 닿는다.
    expect(screen.getAllByTestId('composer-input')).toHaveLength(1);
    expect(screen.getByTestId('conversation-menu')).toBeTruthy();

    const backs = screen.getAllByTestId('header-back');
    expect(backs).toHaveLength(1);
    fireEvent.press(backs[0]);
    await waitFor(() => expect(screen.queryByTestId('conversation-pane', HIDDEN)).toBeNull());
    expectHomeReachable();
  });
});
