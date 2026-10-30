import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import AppShell from '../src/shell/AppShell';
import {setHapticMode} from '../src/lib/haptics';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// 인박스 「전체」 (#3663): 나와 관련된 것의 목록. 폰 1차 범위는 목록 + 이동이다.
//
// 가짜인 것은 `fetch`가 무엇을 답하는가뿐이다. 모델(core `mailbox.ts`)·쿼리 배선·
// 화면은 진짜다. 서버 읽기 계약 그대로의 응답을 준다: read-state, DM 메시지 페이지,
// 멘션 수 뒤의 메시지, 내 글의 `thread` 롤업, 대기 승인.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const ME = '11111111-1111-4111-8111-111111111111';
const SEO = '33333333-3333-4333-8333-333333333333';
const BOT = 'cccccccc-1111-4111-8111-cccccccccccc';
const GENERAL = 'aaaaaaaa-0000-4000-8000-000000000001';
const DM_SEO = 'aaaaaaaa-0000-4000-8000-000000000002';
const DM_BOT = 'aaaaaaaa-0000-4000-8000-000000000003';
const BASE = 'https://api.example.com';
const NOW = 1_700_000_000_000;

const SELF: Member = {id: ME, workspaceId: WS, kind: 'human', displayName: '곽성재', handle: 'seongjae'};
const LOGIN_BODY = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: SELF,
};
const person = (id: string, kind: string, displayName: string, handle: string, extra = {}) => ({
  id, workspaceId: WS, kind, status: 'active', displayName, handle, channelCount: 3,
  channelIds: [GENERAL, DM_SEO, DM_BOT], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const ROSTER = [
  person(ME, 'human', '곽성재', 'seongjae'),
  person(SEO, 'human', '서연', 'seoyeon'),
  person(BOT, 'agent', '김인턴', 'kim-intern', {ownerHumanId: ME}),
];
const CHANNELS = [
  {id: GENERAL, workspaceId: WS, kind: 'public', name: 'general', muted: false},
  {id: DM_SEO, workspaceId: WS, kind: 'dm', dmKey: 'a', memberIds: [ME, SEO], muted: false},
  {id: DM_BOT, workspaceId: WS, kind: 'dm', dmKey: 'b', memberIds: [ME, BOT], muted: false},
];

const msg = (channelId: string, seq: number, author: string, body: string, extra = {}) => ({
  id: `m-${channelId.slice(-1)}-${seq}`, channelId, seq, hlcTs: NOW - seq, hlcCount: 0,
  authorMemberId: author, type: 'text', body, createdAtMs: NOW - (10 - seq) * 60_000, ...extra,
});

interface World {
  readStates: unknown[];
  approvals: unknown[];
  messages: Record<string, unknown[]>;
  afterMessages: Record<string, unknown[]>;
  failMessages?: boolean;
  failApprovals?: boolean;
  /** 에이전트 실행 이력 경로의 응답 상태. 404 면 이 서버엔 그 경로가 없다(미제공). */
  agentRunsStatus?: number;
  /** 없으면 구 서버: `GET /inbox`가 404다. */
  inbox?: {pages: Record<string, unknown>; failStatus?: number};
}

function fullWorld(): World {
  const root = msg(GENERAL, 2, ME, '배포 일정 언제 확정돼요?', {
    thread: {reply_count: 1, last_reply_seq: 9, last_reply_at: NOW - 60_000},
  });
  return {
    readStates: [
      {channel_id: GENERAL, last_read_seq: 4, latest_seq: 9, unread_count: 5, mention_count: 1},
      {channel_id: DM_SEO, last_read_seq: 6, latest_seq: 8, unread_count: 2, mention_count: 0},
      {channel_id: DM_BOT, last_read_seq: 4, latest_seq: 4, unread_count: 0, mention_count: 0},
    ],
    approvals: [{
      id: 'ap-1', workspace_id: WS, run_id: 'r1', channel_id: GENERAL, requested_by: BOT,
      action_type: 'tool_call', status: 'pending', expires_at_ms: NOW + 600_000, created_at_ms: NOW - 1000,
      payload: {tool_call: {name: 'work.session.end'}},
    }],
    messages: {
      [GENERAL]: [root, msg(GENERAL, 8, SEO, '@seongjae 배포 전에 확인 부탁해요', {props: {mention_member_ids: [ME]}})],
      [DM_SEO]: [msg(DM_SEO, 7, SEO, '잠깐 얘기 가능해요?'), msg(DM_SEO, 8, SEO, '오늘 4시 리뷰 같이 봐요')],
      [DM_BOT]: [msg(DM_BOT, 3, ME, '요약 부탁'), msg(DM_BOT, 4, BOT, '정리해서 올렸어요')],
    },
    afterMessages: {
      [GENERAL]: [msg(GENERAL, 8, SEO, '@seongjae 배포 전에 확인 부탁해요', {props: {mention_member_ids: [ME]}})],
    },
  };
}

const json = (status: number, body: unknown): Response =>
  ({status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body)}) as unknown as Response;

function installFetch(world: World) {
  const mock = jest.fn(async (url: string, _init?: {method?: string}) => {
    const target = String(url);
    const parsed = new URL(target);
    if (/\/inbox(\/|$)/.test(parsed.pathname)) {
      if (!world.inbox) return json(404, {error: {code: 'not_found', message: 'not found'}});
      if (world.inbox.failStatus) return json(world.inbox.failStatus, {error: {code: 'internal', message: 'x'}});
      if (parsed.pathname.endsWith('/read')) {
        return json(200, {id: parsed.pathname.split('/').slice(-2)[0], readAt: '2026-10-11T04:10:00.000001Z', unreadCount: 1});
      }
      const probe = parsed.searchParams.get('limit') === '1';
      return json(200, probe
        ? {items: [], nextCursor: null, unreadCount: 0}
        : (world.inbox.pages[parsed.searchParams.get('cursor') ?? ''] ?? {items: [], nextCursor: null, unreadCount: 0}));
    }
    if (target.includes('/approvals')) {
      if (world.failApprovals) return json(500, {error: {code: 'internal', message: 'x'}});
      return json(200, {approvals: parsed.searchParams.get('status') === 'pending' ? world.approvals : []});
    }
    if (target.includes('/agent-runs')) {
      return world.agentRunsStatus
        ? json(world.agentRunsStatus, {error: {code: 'not_found', message: 'absent'}})
        : json(200, {runs: []});
    }
    if (target.includes('/roster')) return json(200, {members: ROSTER});
    if (target.includes('/read-state')) return json(200, {read_states: world.readStates});
    if (target.includes('/replies')) {
      return json(200, {messages: [msg(GENERAL, 9, BOT, '확인 끝났어요', {rootId: 'm-1-2'})]});
    }
    if (target.includes('/messages')) {
      if (world.failMessages) return json(500, {error: {code: 'internal', message: 'x'}});
      const channelId = Object.keys(world.messages).find(id => target.includes(id)) ?? '';
      const after = parsed.searchParams.get('after');
      return json(200, {messages: (after ? world.afterMessages : world.messages)[channelId] ?? []});
    }
    if (target.includes('/channels')) return json(200, {channels: CHANNELS});
    throw new Error(`unrouted request: ${target}`);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

let queryClient: QueryClient | null = null;
function renderShell() {
  queryClient = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {retry: false, gcTime: 0}},
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AppShell member={SELF} />
    </QueryClientProvider>,
  );
}
const mmkvStore = (jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}).__store;
jest.setTimeout(30_000);

async function openInbox() {
  renderShell();
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy(), {timeout: 10_000});
  fireEvent.press(screen.getByTestId('tab-inbox'));
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockImplementation(() => NOW);
  mmkvStore.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin(LOGIN_BODY);
});
afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  jest.restoreAllMocks();
});

const rowKeys = () =>
  screen.queryAllByTestId(/^mailbox-row-/).map(node => String(node.props.testID).replace('mailbox-row-', ''));

describe('인박스 「전체」 (#3663)', () => {
  it('종류가 섞인 목록: 처리할 일이 맨 앞, DM·스레드·멘션이 뒤따르고 읽은 DM도 남는다', async () => {
    installFetch(fullWorld());
    await openInbox();
    await waitFor(() => expect(screen.getByTestId('inbox-list')).toBeTruthy(), {timeout: 10_000});
    await waitFor(() => expect(rowKeys().length).toBe(5), {timeout: 10_000});
    const keys = rowKeys();
    expect(keys[0]).toBe('approval:ap-1');
    expect(keys.some(k => k.startsWith('dm:') && k.includes(DM_SEO))).toBe(true);
    expect(keys.some(k => k.startsWith('dm:') && k.includes(DM_BOT))).toBe(true);
    expect(keys.some(k => k.startsWith('thread:'))).toBe(true);
    expect(keys.some(k => k.startsWith('mention:'))).toBe(true);
  });

  it('안 읽음은 점으로 말한다: 안 읽은 DM엔 있고 읽은 DM엔 없다', async () => {
    installFetch(fullWorld());
    await openInbox();
    await waitFor(() => expect(rowKeys().length).toBe(5), {timeout: 10_000});
    expect(screen.queryByTestId(`mailbox-unread-dm:${DM_SEO}`)).toBeTruthy();
    expect(screen.queryByTestId(`mailbox-unread-dm:${DM_BOT}`)).toBeNull();
  });

  it('DM 칩은 DM만 남기고, 줄을 누르면 그 대화로 간다', async () => {
    installFetch(fullWorld());
    await openInbox();
    await waitFor(() => expect(rowKeys().length).toBe(5), {timeout: 10_000});
    fireEvent.press(screen.getByTestId('inbox-tab-dm'));
    await waitFor(() => expect(rowKeys()).toHaveLength(2));
    expect(rowKeys().every(k => k.startsWith('dm:'))).toBe(true);
    fireEvent.press(within(screen.getByTestId(`mailbox-row-dm:${DM_SEO}`)).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('header-back')).toBeTruthy(), {timeout: 10_000});
  });

  it('아무것도 없으면 조용한 게 정상이라고 말한다', async () => {
    const world = fullWorld();
    world.readStates = world.readStates.map(r => ({...(r as object), last_read_seq: 99, latest_seq: 99, unread_count: 0, mention_count: 0}));
    world.approvals = [];
    world.messages = {[GENERAL]: [], [DM_SEO]: [], [DM_BOT]: []};
    installFetch(world);
    await openInbox();
    await waitFor(() => expect(screen.getByTestId('inbox-empty')).toBeTruthy(), {timeout: 10_000});
    expect(screen.getByTestId('inbox-empty')).toHaveTextContent(/조용한 게 정상이에요/);
  });

  it('시도한 원천이 모두 실패하면 오류와 다시 시도 (하나라도 답하면 있는 만큼 그린다)', async () => {
    const world = fullWorld();
    world.failMessages = true;
    world.failApprovals = true;
    installFetch(world);
    await openInbox();
    await waitFor(() => expect(screen.getByTestId('inbox-error')).toBeTruthy(), {timeout: 10_000});
  });

  it('일부 원천만 실패하면 목록을 지우지 않는다', async () => {
    const world = fullWorld();
    world.failMessages = true; // DM·멘션·스레드는 실패, 승인은 답한다.
    installFetch(world);
    await openInbox();
    await waitFor(() => expect(rowKeys()).toEqual(['approval:ap-1']), {timeout: 10_000});
    expect(screen.queryByTestId('inbox-error')).toBeNull();
  });
});

// ---- 서버 투영 (ADR-0199, #3684) ---------------------------------------------

const wireItem = (id: string, over: Record<string, unknown> = {}) => ({
  id, kind: 'reply_to_me', reasons: ['reply_to_me'],
  channel: {id: GENERAL, name: 'general', kind: 'public'},
  message: {id: `m-${id}`, seq: 8, authorMemberId: BOT, preview: '배포 로그 확인했어요', deleted: false},
  quotedMessage: {id: 'q1', authorMemberId: ME, preview: '배포 어떻게 됐어?', deleted: false},
  actorMemberId: BOT, createdAt: '2026-10-11T04:07:12.123456Z', readAt: null, ...over,
});

function serverWorld(): World {
  const world = fullWorld();
  world.inbox = {
    pages: {
      '': {
        items: [
          wireItem('A1'),
          wireItem('A2', {kind: 'mention', reasons: ['mention'], quotedMessage: undefined, readAt: '2026-10-11T04:09:00.000001Z'}),
        ],
        nextCursor: 'cur-2',
        unreadCount: 1,
      },
      'cur-2': {items: [wireItem('B1', {kind: 'dm', reasons: ['dm'], quotedMessage: undefined})], nextCursor: null, unreadCount: 1},
    },
  };
  return world;
}

const inboxCalls = (mock: jest.Mock) =>
  mock.mock.calls.map(c => new URL(String(c[0]))).filter(u => /\/inbox(\/|$)/.test(u.pathname));

describe('인박스 서버 투영 (#3684)', () => {
  it('서버 항목을 그리고, 읽은 항목은 남되 점이 없고, 답글 칩이 선다. 구 서버 조합은 돌지 않는다', async () => {
    const mock = installFetch(serverWorld());
    await openInbox();
    await waitFor(() => expect(rowKeys()).toContain('inbox:a1'), {timeout: 10_000});
    expect(rowKeys().filter(k => k.startsWith('inbox:'))).toEqual(['inbox:a1', 'inbox:a2']);
    expect(screen.queryByTestId('mailbox-unread-inbox:a1')).toBeTruthy();
    expect(screen.queryByTestId('mailbox-unread-inbox:a2')).toBeNull();
    expect(screen.getByTestId('inbox-tab-reply')).toBeTruthy();
    // 조합 경로의 읽기(DM 최근 페이지)는 한 건도 나가지 않는다.
    expect(mock.mock.calls.some(c => String(c[0]).includes(`/channels/${DM_SEO}/messages`))).toBe(false);
  });

  it('더 보기가 서버 커서로 다음 쪽을 이어 붙인다', async () => {
    const mock = installFetch(serverWorld());
    await openInbox();
    await waitFor(() => expect(screen.getByTestId('inbox-load-more')).toBeTruthy(), {timeout: 10_000});
    fireEvent.press(screen.getByTestId('inbox-load-more'));
    await waitFor(() => expect(rowKeys()).toContain('inbox:b1'), {timeout: 10_000});
    expect(inboxCalls(mock).some(u => u.searchParams.get('cursor') === 'cur-2')).toBe(true);
  });

  it('안 읽은 항목을 누르면 그 항목만 PUT read로 읽음 처리하고 대화로 간다', async () => {
    const mock = installFetch(serverWorld());
    await openInbox();
    await waitFor(() => expect(rowKeys()).toContain('inbox:a1'), {timeout: 10_000});
    fireEvent.press(within(screen.getByTestId('mailbox-row-inbox:a1')).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('header-back')).toBeTruthy(), {timeout: 10_000});
    await waitFor(() => {
      const put = mock.mock.calls.find(c => String(c[0]).endsWith('/inbox/A1/read'));
      expect(put?.[1]?.method).toBe('PUT');
    });
  });

  it('5xx는 구 서버가 아니라 장애다: 후퇴하지 않고 오류를 말한다', async () => {
    const world = serverWorld();
    world.inbox = {pages: {}, failStatus: 500};
    const mock = installFetch(world);
    await openInbox();
    await waitFor(() => expect(screen.getByTestId('inbox-error')).toBeTruthy(), {timeout: 10_000});
    expect(mock.mock.calls.some(c => String(c[0]).includes('/messages'))).toBe(false);
  });
});

describe('인박스 구 서버 후퇴 (#3684)', () => {
  it('판별은 한 번만: 칩을 오가도 /inbox는 한 번 묻고, 답글 칩 없이 클라이언트 조합이 돈다', async () => {
    const mock = installFetch(fullWorld());
    await openInbox();
    await waitFor(() => expect(rowKeys().length).toBe(5), {timeout: 10_000});
    fireEvent.press(screen.getByTestId('inbox-tab-dm'));
    await waitFor(() => expect(rowKeys()).toHaveLength(2));
    fireEvent.press(screen.getByTestId('inbox-tab-all'));
    await waitFor(() => expect(rowKeys().length).toBe(5));
    expect(inboxCalls(mock)).toHaveLength(1);
    expect(screen.queryByTestId('inbox-tab-reply')).toBeNull();
  });
});

// =============================================================================
// 인박스 당겨서 새로고침 (#3962): 클라이언트 조합 경로의 재조회는 키 접두사 **무효화**로 여러 쿼리를 다시 읽는다.
// `invalidateQueries()` 는 쿼리가 실패해도 `undefined` 로 조용히 끝나서, 이 경로를 거친 당김이 실패에 성공
// 햅틱을 냈다(그리고 캐시된 항목이 있는 인박스는 실패를 화면 어디에도 말하지 않는다). 지금은 재조회가 실패까지
// 돌려주고, 당김이 그것을 경고 햅틱과 목록 위의 실패 안내 한 줄로 전한다. 그 한 줄은 **시간으로 사라지지 않는다**(#3992):
// 다음 당김이 서거나, 실패한 쿼리가 다시 읽히거나, 화면(탭·칩)을 떠날 때 거둔다 — 실제 인박스·실제 셸·실제 QueryClient 로 잰다.
//
// 가짜인 것은 `fetch` 가 무엇을 답하는가뿐이다. 아래 둘은 같은 인박스를 같은 방식으로 당기고 `/messages` 만
// 다르게 답하게 한다.
//
// red proof: `useMailbox` 의 무효화를 `invalidateAndReport` 에서 맨 `invalidateQueries` 로 되돌리면 → 실패 시험이 붉다.
//   에이전트 피드의 `ignoreError: serverSaysAbsent` 를 빼면 → 「이 서버에 실행 이력 경로가 없으면」이 붉다.
//   안내에 시간 제한(1.6초 타이머)을 되돌리면 → 「실패 안내는 시간으로 사라지지 않는다」가 붉다.
//   인박스가 `usePullRefresh` 에 `{active, resetKey}` 를 안 넘기면 → 「탭을 옮기면」·「칩을 옮기면」이 붉다.
// =============================================================================
describe('인박스 당겨서 새로고침 (#3962)', () => {
  const haptic = jest.requireMock('expo-haptics') as {__calls: string[]};
  const notifications = () => haptic.__calls.filter(c => c.startsWith('notification:'));
  const pullInbox = () =>
    act(() => {
      screen.getByTestId('inbox-list').props.refreshControl.props.onRefresh();
    });
  /** 목록 위의 실패 안내(#3992). */
  const failedNotice = () => screen.queryByTestId('pull-refresh-failed', {includeHiddenElements: true});

  beforeEach(() => {
    haptic.__calls.length = 0;
  });

  it('DM·멘션·스레드를 읽는 쿼리가 실패하면 당김은 경고 햅틱과 실패 안내로 끝난다', async () => {
    const world = fullWorld();
    installFetch(world);
    await openInbox();
    await waitFor(() => expect(rowKeys().length).toBe(5), {timeout: 10_000});
    world.failMessages = true; // 목록은 이미 캐시돼 있다: 화면에는 항목이 그대로 남는다
    pullInbox();
    await waitFor(() => expect(notifications()).toEqual(['notification:warning']), {timeout: 10_000});
    // 안내는 컨트롤이 닫힌 뒤에 선다(잠깐 뒤).
    await waitFor(() => expect(failedNotice()).not.toBeNull(), {timeout: 10_000});
    expect(rowKeys().length).toBeGreaterThan(0);
  });

  /** 실패한 당김 하나를 거쳐 안내가 선 인박스. 실패한 쿼리를 되살릴 수 있게 세계를 돌려준다. */
  async function inboxWithFailureNotice() {
    const world = fullWorld();
    installFetch(world);
    await openInbox();
    await waitFor(() => expect(rowKeys().length).toBe(5), {timeout: 10_000});
    world.failMessages = true;
    pullInbox();
    await waitFor(() => expect(failedNotice()).not.toBeNull(), {timeout: 10_000});
    return world;
  }

  it('실패 안내는 시간으로 사라지지 않는다: 옛 1.6초가 지나고도 실제 인박스에 서 있다', async () => {
    await inboxWithFailureNotice();
    await new Promise(resolve => setTimeout(resolve, 2_000));
    expect(failedNotice()).not.toBeNull();
    expect(rowKeys().length).toBeGreaterThan(0);
  });

  it('다음 당김이 서면 안내가 사라진다', async () => {
    setHapticMode('basic'); // 안내 초기화 시험은 기존 완료 햅틱을 기다리는 조건을 보존한다.
    const world = await inboxWithFailureNotice();
    world.failMessages = false;
    pullInbox();
    expect(failedNotice()).toBeNull();
    await waitFor(() => expect(notifications()).toEqual(['notification:warning', 'notification:success']), {
      timeout: 10_000,
    });
    expect(failedNotice()).toBeNull();
  });

  it('실패한 쿼리가 다시 읽히면(재연결 뒤 재조회 따위) 안내가 사라진다', async () => {
    const world = await inboxWithFailureNotice();
    world.failMessages = false;
    await act(async () => {
      await queryClient!.invalidateQueries();
    });
    await waitFor(() => expect(failedNotice()).toBeNull(), {timeout: 10_000});
  });

  it('칩을 옮기면 안내가 사라진다: 다른 목록 위에서는 거짓이다', async () => {
    await inboxWithFailureNotice();
    fireEvent.press(screen.getByTestId('inbox-tab-dm'));
    expect(failedNotice()).toBeNull();
    fireEvent.press(screen.getByTestId('inbox-tab-all'));
    expect(failedNotice()).toBeNull(); // 돌아와도 옛 실패는 서 있지 않다
  });

  it('탭을 옮기면(홈으로) 안내가 사라지고, 인박스로 돌아와도 서 있지 않다', async () => {
    await inboxWithFailureNotice();
    fireEvent.press(screen.getByTestId('tab-home'));
    expect(failedNotice()).toBeNull();
    fireEvent.press(screen.getByTestId('tab-inbox'));
    expect(failedNotice()).toBeNull();
  });

  it('멘션 탭(승인 원장이 아닌 무효화 피드)도 읽기가 실패하면 경고다', async () => {
    const world = fullWorld();
    installFetch(world);
    await openInbox();
    await waitFor(() => expect(rowKeys().length).toBe(5), {timeout: 10_000});
    fireEvent.press(screen.getByTestId('inbox-tab-mentions'));
    await waitFor(() => expect(screen.getByTestId('inbox-list')).toBeTruthy(), {timeout: 10_000});
    world.failMessages = true;
    pullInbox();
    await waitFor(() => expect(notifications()).toEqual(['notification:warning']), {timeout: 10_000});
  });

  it('에이전트 탭(승인·런 원장 무효화 피드)도 원장 읽기가 실패하면 경고다', async () => {
    const world = fullWorld();
    installFetch(world);
    await openInbox();
    await waitFor(() => expect(rowKeys().length).toBe(5), {timeout: 10_000});
    fireEvent.press(screen.getByTestId('inbox-tab-agents'));
    await waitFor(() => expect(screen.queryByTestId('inbox-list') ?? screen.queryByTestId('inbox-empty')).toBeTruthy(), {
      timeout: 10_000,
    });
    world.failApprovals = true;
    act(() => {
      (screen.queryByTestId('inbox-list') ?? screen.getByTestId('inbox-empty')).props.refreshControl.props.onRefresh();
    });
    await waitFor(() => expect(notifications()).toEqual(['notification:warning']), {timeout: 10_000});
  });

  it('에이전트 탭: 이 서버에 실행 이력 경로가 없으면(404) 실패가 아니다 — 화면이 미제공으로 접는 오류다', async () => {
    setHapticMode('basic'); // 서버의 미제공 판별은 기존 성공 햅틱으로 완료를 확인한다.
    const world = fullWorld();
    installFetch(world);
    await openInbox();
    await waitFor(() => expect(rowKeys().length).toBe(5), {timeout: 10_000});
    fireEvent.press(screen.getByTestId('inbox-tab-agents'));
    await waitFor(() => expect(screen.queryByTestId('inbox-list') ?? screen.queryByTestId('inbox-empty')).toBeTruthy(), {
      timeout: 10_000,
    });
    world.agentRunsStatus = 404;
    act(() => {
      (screen.queryByTestId('inbox-list') ?? screen.getByTestId('inbox-empty')).props.refreshControl.props.onRefresh();
    });
    await waitFor(() => expect(notifications()).toEqual(['notification:success']), {timeout: 10_000});
    expect(screen.queryByTestId('pull-refresh-failed', {includeHiddenElements: true})).toBeNull();
  });

  it('풍부는 모두 잘 읽혀도 성공 햅틱이 없고 실패 안내도 없다', async () => {
    installFetch(fullWorld());
    await openInbox();
    await waitFor(() => expect(rowKeys().length).toBe(5), {timeout: 10_000});
    pullInbox();
    expect(screen.getByTestId('inbox-list').props.refreshControl.props.refreshing).toBe(true);
    await waitFor(() => expect(screen.getByTestId('inbox-list').props.refreshControl.props.refreshing).toBe(false), {
      timeout: 10_000,
    });
    expect(notifications()).toEqual([]);
    expect(failedNotice()).toBeNull();
  });
});
