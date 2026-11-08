import type {Member} from '@momo/core/lib/api';
import {THREAD_COMPOSER_PLACEHOLDER} from '@momo/core/features/chat/composerCopy';
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
// 스레드 판이 열린 동안 판 뒤의 채널 화면은 화면 낭독에 닿지 않는다 (#5544, S12 검증 7c A-B1).
//
// 스레드 판은 대화 화면 전체를 덮는 불투명한 면이다. 판 뒤의 채널 입력창·보내기 단추·머리(‹·⋮)는 눈에 안 보이는데 낭독 트리에 남아 있으면
// VoiceOver 초점이 닿아, 스레드에 답한다고 믿고 채널에 보내거나 스레드를 닫는다고 믿고 대화를 나갈 수 있다. 두 겹으로 뺀다:
//   · 대화 틀 `conversation-layout-wrap`(목록·채널 입력창) — iOS `accessibilityElementsHidden` + Android `no-hide-descendants`(#5364 와 같은 조건 하나).
//   · 스레드 판의 뿌리 `accessibilityViewIsModal` — 형제인 채널 머리까지 뺀다(iOS, 같은 층의 정보 페이지와 같은 자리).
// 셸·화면·판은 전부 진짜이고 가짜는 서버 경계(`fetch`) 하나다. RNTL 의 기본 찾기는 낭독에서 빠진 요소를 찾지 않는다(위 세 속성과 모달 형제를 모두
// 따진다) — 그래서 「기본 찾기 1개 · 숨은 것까지 2개」가 「마운트는 그대로, 낭독에서만 빠짐」을 잰다. 시뮬레이터 접근성 계층의 같은 숫자는 PR 본문에 있다.
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

/** 남이 쓴 루트 하나와 내 답글 하나 — 본류의 루트 행에 「답글 1개」 롤업(`thread-rollup`)이 선다. */
const ROOT_ID = 'msg-root';
const BASE_MS = 1_700_000_000_000;
const HISTORY = [
  {id: ROOT_ID, seq: 1, authorMemberId: PEER_ID, body: '배포는 금요일 오전 10시예요.'},
  {id: 'msg-reply', seq: 2, authorMemberId: SELF_ID, body: '확인했어요.', rootId: ROOT_ID},
].map(entry => ({
  channelId: GENERAL,
  hlcTs: entry.seq,
  hlcCount: 0,
  type: 'text',
  state: 'sent',
  createdAtMs: BASE_MS + entry.seq * 1000,
  ...entry,
}));

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
const layoutWrap = () => screen.getByTestId('conversation-layout-wrap', HIDDEN);

async function openGeneral() {
  renderShell();
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
  fireEvent.press(screen.getByTestId(`sidebar-row-channel:${GENERAL}`));
  return screen.findByTestId('thread-rollup');
}

/** 채널만 보는 상태: 틀은 낭독에 있고(Android 속성은 펼치지 않아 기본값 `auto`), 닿는 입력창·보내기·머리는 채널의 것 하나씩이다. */
function expectChannelReachable() {
  expect(layoutWrap().props.accessibilityElementsHidden).toBe(false);
  expect(layoutWrap().props.importantForAccessibility).toBeUndefined();
  const inputs = screen.getAllByTestId('composer-input');
  expect(inputs).toHaveLength(1);
  expect(inputs[0].props.accessibilityLabel).not.toBe(THREAD_COMPOSER_PLACEHOLDER);
  expect(screen.getAllByTestId('composer-send')).toHaveLength(1);
  expect(screen.getByTestId('conversation-title')).toBeTruthy();
  expect(screen.getByTestId('conversation-menu')).toBeTruthy();
}

describe('스레드 판이 열린 동안 판 뒤의 채널 화면은 화면 낭독에서 빠진다 (#5544)', () => {
  it('열면 대화 틀(목록·채널 입력창)과 채널 머리가 빠져 닿는 입력창·보내기·‹ 는 스레드의 것 하나씩이고, 닫으면 채널 것이 돌아온다', async () => {
    const rollup = await openGeneral();
    expectChannelReachable();

    fireEvent.press(rollup);
    await screen.findByTestId('thread-title');

    // 대화 틀은 두 플랫폼 모두에서 빠진다(iOS · Android 한 쌍, `ShellChrome` 의 `coveredProps` 와 같다).
    expect(layoutWrap().props.accessibilityElementsHidden).toBe(true);
    expect(layoutWrap().props.importantForAccessibility).toBe('no-hide-descendants');
    // 입력창·보내기는 둘 다 마운트돼 있다(채널 초안은 그대로 남는다) — 낭독이 닿는 것은 스레드의 것 하나씩이다.
    expect(screen.getAllByTestId('composer-input', HIDDEN)).toHaveLength(2);
    const inputs = screen.getAllByTestId('composer-input');
    expect(inputs).toHaveLength(1);
    expect(inputs[0].props.accessibilityLabel).toBe(THREAD_COMPOSER_PLACEHOLDER);
    expect(screen.getAllByTestId('composer-send', HIDDEN)).toHaveLength(2);
    expect(screen.getAllByTestId('composer-send')).toHaveLength(1);
    // 채널 머리(‹ · 이름 · 돋보기 · ⋮)도 판 뒤에서 빠진다 — 판이 모달 경계다. 닿는 ‹ 는 「스레드 닫기」 하나다.
    expect(screen.getByTestId('conversation-title', HIDDEN)).toBeTruthy();
    expect(screen.queryByTestId('conversation-title')).toBeNull();
    expect(screen.queryByTestId('conversation-menu')).toBeNull();
    expect(screen.getAllByTestId('header-back', HIDDEN)).toHaveLength(2);
    const backs = screen.getAllByTestId('header-back');
    expect(backs).toHaveLength(1);
    expect(backs[0].props.accessibilityLabel).toBe('스레드 닫기');

    fireEvent.press(screen.getByLabelText('스레드 닫기'));
    await waitFor(() => expect(screen.queryByTestId('thread-title', HIDDEN)).toBeNull());
    expectChannelReachable();
  });
});
