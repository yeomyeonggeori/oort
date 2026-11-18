import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react-native';
import React from 'react';
import {ActionSheetIOS} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {resetAgentWorking} from '../src/features/agents/workingSignal';
import {FILTER_ACTION} from '../src/screens/SidebarScreen';
import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// 폰 채널 둘러보기와 참여 (#5846, ADR-0224 화면 폰 줄 · D3 · D4 · D8). 배송되는 셸(`AppShell`) 안에서, 서버는 가짜 응답(E2 #5838 의
// 계약: `GET …/channels/browse` · `POST …/channels/{ch}/members/me`)으로 잰다. 채널 · 사람 이름은 가상이다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const PEER_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const BASE = 'https://api.example.com';

const SELF: Member = {id: SELF_ID, workspaceId: WS, kind: 'human', displayName: '김도현', handle: 'dohyun'};

function rosterMember(over: Record<string, unknown>) {
  return {
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    displayName: '이름',
    handle: 'handle',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

const rosterWith = (role: string | undefined) => [
  rosterMember({id: SELF_ID, displayName: '김도현', handle: 'dohyun', ...(role ? {role} : {})}),
  rosterMember({id: PEER_ID, displayName: '박서연', handle: 'seoyeon', role: 'member'}),
];

const MY_CHANNELS = [
  {id: 'ch-general', workspaceId: WS, kind: 'public', name: 'general', muted: false},
];

const DESIGN = {id: 'ch-design-review', name: '디자인-리뷰', topic: '주간 시안 리뷰', memberCount: 8, isMember: false, isDefault: false};
const LAUNCH = {id: 'ch-launch', name: '출시-준비', memberCount: 5, isMember: false, isDefault: false};
const GENERAL = {id: 'ch-general', name: 'general', memberCount: 12, isMember: true, isDefault: true};
const BROWSE = [DESIGN, GENERAL, LAUNCH];

function jsonResponse(status: number, body: unknown): Response {
  return {status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body)} as unknown as Response;
}

type JoinAnswer = 'ok' | 404 | 429 | 'network' | 'hold';

interface Routes {
  role?: string;
  browse?: unknown[];
  join?: JoinAnswer;
}

/** 참여가 `'hold'` 일 때 풀어 줄 손잡이. */
let releaseJoin: (() => void) | null = null;

function installFetch(routes: Routes): jest.Mock {
  const channels: Record<string, unknown>[] = [...MY_CHANNELS];
  const mock = jest.fn(async (url: string, init?: {method?: string}) => {
    const method = init?.method ?? 'GET';
    if (url.includes('/channels/browse')) {
      return jsonResponse(200, {channels: routes.browse ?? BROWSE});
    }
    const join = /\/channels\/([^/]+)\/members\/me$/.exec(url);
    if (join && method === 'POST') {
      const answer = routes.join ?? 'ok';
      if (answer === 'network') throw new TypeError('Network request failed');
      if (answer === 404) return jsonResponse(404, {error: {message: 'channel not found'}});
      if (answer === 429) return jsonResponse(429, {error: {message: 'rate limited'}});
      if (answer === 'hold') await new Promise<void>(resolve => (releaseJoin = resolve));
      const row = BROWSE.find(candidate => candidate.id === join[1]);
      const channel = {id: join[1], workspaceId: WS, kind: 'public', name: row?.name, memberIds: [], muted: false, browseListed: true, isDefault: false};
      channels.push(channel);
      return jsonResponse(200, {channel, newlyJoined: true});
    }
    if (url.includes('/channels') && !url.includes('/messages')) return jsonResponse(200, {channels});
    if (url.includes('/roster')) return jsonResponse(200, {members: rosterWith(routes.role)});
    if (url.includes('/read-state')) return jsonResponse(200, {read_states: []});
    if (url.includes('/messages')) return jsonResponse(200, {messages: []});
    if (url.includes('/approvals')) return jsonResponse(200, {approvals: []});
    if (url.includes('/work-sessions')) return jsonResponse(200, {sessions: []});
    if (/\/v1\/workspaces\/[^/]+$/.test(url)) {
      return jsonResponse(200, {workspace: {id: WS, slug: 'saebyeok', name: '새벽팀', updatedAtMs: 0}});
    }
    return jsonResponse(200, {});
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

let queryClient: QueryClient | null = null;

async function mountHome(routes: Routes = {role: 'member'}): Promise<jest.Mock> {
  const fetchMock = installFetch(routes);
  queryClient = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {retry: false, gcTime: 0}},
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AppShell member={SELF} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
  // 명부가 와야 문 판정이 선다(역할을 읽는다).
  await waitFor(() => expect(fetchMock.mock.calls.some(call => String(call[0]).includes('/roster'))).toBe(true));
  return fetchMock;
}

function channelsMenu(choose?: string): string[] {
  let offered: string[] = [];
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((options, callback) => {
    offered = options.options;
    if (choose !== undefined) callback(options.options.indexOf(choose));
  });
  fireEvent.press(screen.getByTestId('home-section-menu-channels'));
  return offered;
}

const joinCalls = (fetchMock: jest.Mock) =>
  fetchMock.mock.calls.filter(call => /\/members\/me$/.test(String(call[0])) && call[1]?.method === 'POST');

async function openBrowse(): Promise<void> {
  channelsMenu('채널 둘러보기');
  await waitFor(() => expect(screen.getByTestId('channel-browse-pane')).toBeTruthy());
  await waitFor(() => expect(screen.getByTestId('channel-browse-body-ready')).toBeTruthy());
}

beforeEach(() => {
  (jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}).__store.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin({
    accessToken: 'access-token-1',
    refreshToken: 'refresh-token-1',
    realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
    member: SELF,
  });
  resetAgentWorking();
  releaseJoin = null;
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  jest.restoreAllMocks();
});

describe('문 — 「채널」 섹션 ⋯ 메뉴의 「채널 둘러보기」는 정식 멤버에게만', () => {
  it.each([
    ['owner', true],
    ['admin', true],
    ['member', true],
    ['guest', false],
    [undefined, false],
  ])('역할 %s → 문 %s', async (role, offered) => {
    await mountHome({role});
    await waitFor(() => expect(screen.getByText('general')).toBeTruthy());
    const options = channelsMenu();
    expect(options.includes('채널 둘러보기')).toBe(offered);
    // 메뉴의 다른 문은 그대로다(+ 메뉴 · 섹션 메뉴의 기존 줄을 건드리지 않음).
    expect(options.slice(0, 2)).toEqual([FILTER_ACTION, '메시지 검색']);
  });
});

describe('화면 — 서버 목록 그대로, 참여하지 않은 채널이 위', () => {
  it('서버가 준 줄만 서고(켜진 채널만 — 거르기는 서버 몫), 참여 안 한 줄이 서버 차례대로 위에', async () => {
    const fetchMock = await mountHome();
    await openBrowse();
    const pane = within(screen.getByTestId('channel-browse-pane'));
    const rowIds = pane
      .getAllByTestId(/^channel-browse-row-ch-/)
      .map(node => String(node.props.testID).replace('channel-browse-row-', ''));
    expect(rowIds).toEqual(['ch-design-review', 'ch-launch', 'ch-general']);
    expect(pane.getByTestId('channel-browse-join-ch-design-review')).toBeTruthy();
    expect(pane.getByTestId('channel-browse-open-ch-general')).toBeTruthy();
    expect(pane.getByTestId('channel-browse-default-ch-general')).toBeTruthy();
    expect(fetchMock.mock.calls.filter(call => String(call[0]).includes('/channels/browse')).length).toBeGreaterThan(0);
  });
});

describe('참여', () => {
  it('두 번 눌러도 요청은 하나, 성공하면 홈에 그 줄이 서고 그 대화가 열린다', async () => {
    const fetchMock = await mountHome({role: 'member', join: 'hold'});
    await openBrowse();
    const button = screen.getByTestId('channel-browse-join-ch-design-review');
    fireEvent.press(button);
    fireEvent.press(button);
    await waitFor(() => expect(releaseJoin).not.toBeNull());
    expect(joinCalls(fetchMock)).toHaveLength(1);
    // 답을 풀고 응답 처리(약속 사슬)가 끝날 때까지 실제 시간을 조금 준다 — waitFor 의 폴링은 act 안에서 그 사슬을 다 돌리지 못했다.
    await act(async () => {
      releaseJoin?.();
      await new Promise(resolve => setTimeout(resolve, 100));
    });
    await waitFor(() => expect(screen.queryByTestId('channel-browse-pane')).toBeNull());
    expect(screen.getByTestId('conversation-pane')).toBeTruthy();
    expect(joinCalls(fetchMock)).toHaveLength(1);
    // 홈 목록(대화 밑)에 새 채널 줄이 섰다 — 채널 목록 캐시에 응답의 channel 을 세웠다.
    // 탭 판은 층 밑에서 낭독에서 빠져 있어 숨은 요소까지 찾는다.
    expect(
      screen.getByTestId('sidebar-row-channel:ch-design-review', {includeHiddenElements: true}),
    ).toBeTruthy();
  });

  it.each([
    [404 as JoinAnswer, '이 채널은 이제 둘러보기에 없어요.', false],
    [429 as JoinAnswer, '요청이 너무 잦아요. 잠시 뒤에 다시 시도해 주세요.', true],
    ['network' as JoinAnswer, /^참여하지 못했어요\./, true],
  ])('실패 %s → 그 줄에 문장, 다시 시도 단추 %s', async (answer, sentence, retry) => {
    await mountHome({role: 'member', join: answer});
    await openBrowse();
    fireEvent.press(screen.getByTestId('channel-browse-join-ch-design-review'));
    const error = await screen.findByTestId('channel-browse-row-error-ch-design-review');
    expect(error.props.children).toEqual(typeof sentence === 'string' ? sentence : expect.stringMatching(sentence));
    // 줄은 같은 자리에 남는다(지우지 않는다). 404 는 단추가 없고, 그 밖은 「다시 시도」.
    expect(screen.getByTestId('channel-browse-row-ch-design-review')).toBeTruthy();
    if (retry) {
      expect(within(screen.getByTestId('channel-browse-join-ch-design-review')).getByText('다시 시도')).toBeTruthy();
    } else {
      expect(screen.queryByTestId('channel-browse-join-ch-design-review')).toBeNull();
    }
    expect(screen.getByTestId('channel-browse-pane')).toBeTruthy();
  });
});

describe('홈 이름 검색 — 「참여하지 않은 공개 채널」 묶음', () => {
  it('내 채널 목록에 없는 이름만 서고, 고르면 둘러보기가 그 이름으로 열린다', async () => {
    await mountHome();
    await waitFor(() => expect(screen.getByText('general')).toBeTruthy());
    channelsMenu(FILTER_ACTION);
    const field = await screen.findByTestId('sidebar-search');
    // 'gen' 은 general 에만 맞는다 — 이미 든 채널이라 묶음에서 빠진다(묶음 없음).
    fireEvent.changeText(field, 'gen');
    await waitFor(() => expect(screen.getByTestId('sidebar-row-channel:ch-general')).toBeTruthy());
    expect(screen.queryByTestId('home-not-joined-group')).toBeNull();
    // '디자' 는 참여 안 한 디자인-리뷰에만 맞는다. 내 채널이 0 줄이어도 「검색 결과가 없습니다」는 서지 않는다.
    fireEvent.changeText(field, '디자');
    const group = await screen.findByTestId('home-not-joined-group');
    expect(within(group).getByTestId('home-not-joined-ch-design-review')).toBeTruthy();
    expect(within(group).queryByTestId('home-not-joined-ch-launch')).toBeNull();
    expect(screen.queryByTestId('channels-no-match')).toBeNull();
    fireEvent.press(within(group).getByTestId('home-not-joined-ch-design-review'));
    await waitFor(() => expect(screen.getByTestId('channel-browse-pane')).toBeTruthy());
    expect(screen.getByTestId('channel-browse-search').props.value).toBe('디자인-리뷰');
  });

  it('게스트에게는 묶음이 없다(서버 목록을 읽지도 않는다)', async () => {
    const fetchMock = await mountHome({role: 'guest'});
    await waitFor(() => expect(screen.getByText('general')).toBeTruthy());
    channelsMenu(FILTER_ACTION);
    fireEvent.changeText(await screen.findByTestId('sidebar-search'), '디자');
    await waitFor(() => expect(screen.getByTestId('channels-no-match')).toBeTruthy());
    expect(screen.queryByTestId('home-not-joined-group')).toBeNull();
    expect(fetchMock.mock.calls.some(call => String(call[0]).includes('/channels/browse'))).toBe(false);
  });
});
