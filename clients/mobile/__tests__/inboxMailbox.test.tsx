import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
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
  const mock = jest.fn(async (url: string) => {
    const target = String(url);
    const parsed = new URL(target);
    if (target.includes('/approvals')) {
      if (world.failApprovals) return json(500, {error: {code: 'internal', message: 'x'}});
      return json(200, {approvals: parsed.searchParams.get('status') === 'pending' ? world.approvals : []});
    }
    if (target.includes('/agent-runs')) return json(200, {runs: []});
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
    expect(screen.getByTestId('inbox-empty')).toHaveTextContent(/조용한 게 정상입니다/);
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
