import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider, focusManager} from '@tanstack/react-query';
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
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// 받은함의 안 읽음 점은 서버가 아는 읽음과 맞아야 한다 (#5331, 팀원 QA).
//
// 서버 투영(ADR-0199 D3)은 한 방향으로 읽음을 옮긴다: 채널 읽음 위치(`PUT read-state`)가 전진하면
// 같은 트랜잭션에서 그 채널의 `seq <= 위치`인 항목이 읽음이 된다. 서버는 늘 맞다(레인 실측: 같은
// 대화의 항목 셋 중 하나만 눌러도 위치가 도착하면 셋이 읽음). 어긋남은 **폰이 들고 있는 목록**에서
// 났다 — 받은함 목록은 위치가 움직여도 다시 읽히지 않았다:
//
//   · 줄을 눌러 대화를 열면 그 한 항목의 읽음 PUT이 끝나는 즉시 목록을 다시 읽는데, 그때 대화의
//     읽음 위치는 아직 안 갔다(타임라인을 읽고 600ms 합친 뒤에 간다). 같은 대화의 다른 항목은
//     안 읽음으로 캐시되고 그 뒤로 아무것도 다시 읽지 않는다.
//   · 홈에서 대화를 읽고 받은함 탭으로 와도 같다(탭은 언마운트가 아니고 대화는 탭 위의 덮개다).
//   · 다른 기기가 항목 하나만 읽음으로 누른 것(채널 위치는 안 움직인다)은 목록을 다시 읽어야만 온다.
//
// 가짜인 것은 서버의 답뿐이다. **읽음 규칙(위치→항목)은 서버와 같은 한 줄**로 가짜 서버에 들어
// 있고, 화면·쿼리·캐시는 진짜다. 점은 `mailbox-unread-<행 키>`로 잰다. 시험 쿼리 클라이언트는
// 폰의 것과 같은 포커스 규칙(`refetchOnWindowFocus: false`)을 쓴다 — 기본값(켬)이면 포커스
// 시험이 이 화면의 코드 없이도 통과한다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const ME = '11111111-1111-4111-8111-111111111111';
const SEO = '33333333-3333-4333-8333-333333333333';
const DM_SEO = 'aaaaaaaa-0000-4000-8000-000000000002';
const BASE = 'https://api.example.com';

const SELF: Member = {id: ME, workspaceId: WS, kind: 'human', displayName: '곽성재', handle: 'seongjae'};
const LOGIN_BODY = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: SELF,
};
const person = (id: string, kind: string, displayName: string, handle: string) => ({
  id, workspaceId: WS, kind, status: 'active', displayName, handle, channelCount: 1,
  channelIds: [DM_SEO], capabilities: [], createdAtMs: 0, updatedAtMs: 0,
});
const ROSTER = [person(ME, 'human', '곽성재', 'seongjae'), person(SEO, 'human', '서연', 'seoyeon')];
const CHANNELS = [{id: DM_SEO, workspaceId: WS, kind: 'dm', dmKey: 'a', memberIds: [ME, SEO], muted: false}];

interface Item {
  id: string;
  channelId: string;
  seq: number;
  readAt: string | null;
}

/** 서버가 들고 있는 사실. 항목 읽음은 둘 중 하나로만 바뀐다: 그 항목의 PUT, 또는 위치 전진. */
interface Server {
  items: Item[];
  cursor: Record<string, number>;
  latest: Record<string, number>;
  /** 받은 요청의 줄(메서드 + 경로). */
  log: string[];
  /** 걸려 있으면 목록 조회는 이 스냅샷으로만 답한다 — 위치가 움직여도 낡은 채로 남는 목록. */
  frozenList?: Item[];
}

const READ_AT = '2026-11-05T06:00:00.000001Z';

function dmServer(unreadSeqs: number[]): Server {
  return {
    items: unreadSeqs.map(seq => ({id: `ITEM-${seq}`, channelId: DM_SEO, seq, readAt: null})),
    cursor: {[DM_SEO]: 0},
    latest: {[DM_SEO]: Math.max(...unreadSeqs)},
    log: [],
  };
}

const wireItem = (item: Item) => ({
  id: item.id, kind: 'dm', reasons: ['dm'],
  channel: {id: item.channelId, name: null, kind: 'dm'},
  message: {id: `m-${item.seq}`, seq: item.seq, authorMemberId: SEO, preview: `메시지 ${item.seq}`, deleted: false},
  actorMemberId: SEO,
  createdAt: `2026-11-05T05:0${item.seq}:00.000000Z`,
  readAt: item.readAt,
});

const json = (status: number, body: unknown): Response =>
  ({status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body)}) as unknown as Response;

function readStateOf(server: Server, channelId: string) {
  const last = server.cursor[channelId] ?? 0;
  const latest = server.latest[channelId] ?? 0;
  return {
    channel_id: channelId, last_read_seq: last, latest_seq: latest,
    unread_count: Math.max(0, latest - last), mention_count: 0,
  };
}

/** 서버의 읽음 규칙: 위치가 `seq`까지 전진하면 그 채널의 `seq <= 위치` 안 읽은 항목이 읽음이 된다(ADR-0199 D3). */
function advanceCursor(server: Server, channelId: string, requested: number) {
  const next = Math.min(Math.max(server.cursor[channelId] ?? 0, requested), server.latest[channelId] ?? 0);
  server.cursor[channelId] = next;
  for (const item of server.items) {
    if (item.channelId === channelId && item.seq <= next && item.readAt === null) item.readAt = READ_AT;
  }
}

/** 다른 기기가 항목 하나만 읽음으로 눌렀다: 항목만 읽음이 되고 채널 위치는 그대로다(D3: 항목 → 위치 방향은 없다). */
function readItemOnly(server: Server, id: string) {
  const item = server.items.find(candidate => candidate.id === id);
  if (item && item.readAt === null) item.readAt = READ_AT;
}

function installFetch(server: Server) {
  const mock = jest.fn(async (url: string, init?: {method?: string; body?: string}) => {
    const target = String(url);
    const parsed = new URL(target);
    const method = init?.method ?? 'GET';
    server.log.push(`${method} ${parsed.pathname}${parsed.search}`);

    if (/\/inbox(\/|$)/.test(parsed.pathname)) {
      if (method === 'PUT' && parsed.pathname.endsWith('/read')) {
        const id = parsed.pathname.split('/').slice(-2)[0];
        readItemOnly(server, id);
        return json(200, {id, readAt: READ_AT, unreadCount: server.items.filter(i => i.readAt === null).length});
      }
      const probe = parsed.searchParams.get('limit') === '1';
      const filter = parsed.searchParams.get('filter') ?? 'all';
      const source = server.frozenList ?? server.items;
      const shown = probe ? [] : [...source]
        .filter(item => filter === 'all' || filter === 'dm' || filter === 'unread' && item.readAt === null)
        .sort((a, b) => b.seq - a.seq)
        .map(wireItem);
      return json(200, {
        items: shown, nextCursor: null,
        unreadCount: source.filter(item => item.readAt === null).length,
      });
    }
    const channelRead = /\/channels\/([^/]+)\/read-state$/.exec(parsed.pathname);
    if (channelRead && method === 'PUT') {
      const body = JSON.parse(init?.body ?? '{}') as {last_read_seq?: number};
      advanceCursor(server, channelRead[1], body.last_read_seq ?? 0);
      return json(200, readStateOf(server, channelRead[1]));
    }
    if (target.includes('/read-state')) {
      return json(200, {read_states: Object.keys(server.latest).map(id => readStateOf(server, id))});
    }
    if (target.includes('/approvals')) return json(200, {approvals: []});
    if (target.includes('/agent-runs')) return json(200, {runs: []});
    if (target.includes('/roster')) return json(200, {members: ROSTER});
    if (target.includes('/replies')) return json(200, {messages: []});
    const messages = /\/channels\/([^/]+)\/messages/.exec(parsed.pathname);
    if (messages) {
      const latest = server.latest[messages[1]] ?? 0;
      const after = Number(parsed.searchParams.get('after') ?? 0);
      return json(200, {
        messages: Array.from({length: latest}, (_, index) => index + 1)
          .filter(seq => seq > after)
          .map(seq => ({
            id: `m-${seq}`, channelId: messages[1], seq, hlcTs: seq, hlcCount: 0,
            authorMemberId: SEO, type: 'text', body: `메시지 ${seq}`, createdAtMs: 1_700_000_000_000 + seq * 60_000,
          })),
      });
    }
    if (target.includes('/channels')) return json(200, {channels: CHANNELS});
    return json(404, {error: {code: 'not_found', message: 'not found'}});
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

let queryClient: QueryClient | null = null;
function renderShell() {
  queryClient = new QueryClient({
    defaultOptions: {
      // 폰의 클라이언트와 같은 포커스 규칙(`createQueryClient`): 포커스가 돌아와도 쿼리가 스스로 다시 읽지 않는다.
      queries: {retry: false, gcTime: 0, refetchOnWindowFocus: false},
      mutations: {retry: false, gcTime: 0},
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AppShell member={SELF} />
    </QueryClientProvider>,
  );
}
const mmkvStore = (jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}).__store;
jest.setTimeout(40_000);

const dots = () => screen.queryAllByTestId(/^mailbox-unread-/).map(node => String(node.props.testID));
const rows = () => screen.queryAllByTestId(/^mailbox-row-/).length;
const inboxGets = (server: Server) =>
  server.log.filter(line => line.startsWith('GET ') && /\/inbox\?/.test(line) && !line.includes('limit=1'));
const cursorPuts = (server: Server) => server.log.filter(line => line.startsWith('PUT ') && line.endsWith('/read-state'));

async function showInboxWith(server: Server, expectedRows: number) {
  installFetch(server);
  renderShell();
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy(), {timeout: 10_000});
  fireEvent.press(screen.getByTestId('tab-inbox'));
  await waitFor(() => expect(rows()).toBe(expectedRows), {timeout: 10_000});
}

/** 대화 화면이 위치를 보내고(타임라인을 읽은 뒤 600ms 합침) 그 응답이 처리될 때까지. */
async function untilCursorLands(server: Server, before: number) {
  await waitFor(() => expect(cursorPuts(server).length).toBeGreaterThan(before), {timeout: 10_000});
  // 응답 뒤의 약속 사슬(읽음 위치 투영 재조회)이 끝나도록 한 박자 둔다.
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 150));
  });
}

async function goBack() {
  fireEvent.press(screen.getByTestId('header-back'));
  await waitFor(() => expect(screen.queryByTestId('header-back')).toBeNull(), {timeout: 10_000});
}

beforeEach(() => {
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

describe('받은함 점은 읽음 위치를 따라간다 (#5331)', () => {
  it('줄 하나를 눌러 대화를 읽고 돌아오면, 같은 대화의 앞선 항목도 점이 없다', async () => {
    const server = dmServer([1, 2, 3]);
    await showInboxWith(server, 3);
    expect(dots()).toHaveLength(3);

    // 가장 새 줄을 누른다: 그 항목의 읽음 PUT, 대화 열림, 그리고 600ms 뒤 위치 PUT.
    fireEvent.press(within(screen.getByTestId('mailbox-row-inbox:item-3')).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('header-back')).toBeTruthy(), {timeout: 10_000});
    await untilCursorLands(server, 0);
    // 서버 사실: 위치가 3까지 갔으니 셋 모두 읽음이다.
    expect(server.items.map(item => item.readAt)).toEqual([READ_AT, READ_AT, READ_AT]);

    await goBack();
    // 목록 새로고침(당김)이나 앱 재시작 없이도 폰의 점이 서버와 같다.
    await waitFor(() => expect(dots()).toEqual([]), {timeout: 10_000});
    expect(rows()).toBe(3);
  });

  it('홈에서 그 대화를 읽고 받은함 탭으로 오면, 목록이 낡은 채여도 위치를 지난 항목은 점이 없다', async () => {
    const server = dmServer([1, 2]);
    await showInboxWith(server, 2);
    expect(dots()).toHaveLength(2);
    // 이 뒤로 목록 조회는 처음 받은 모습만 답한다: 점을 끌 수 있는 것은 읽음 위치뿐이다.
    server.frozenList = server.items.map(item => ({...item}));

    fireEvent.press(screen.getByTestId('tab-home'));
    await waitFor(() => expect(screen.getByTestId(`sidebar-row-dm:${DM_SEO}`)).toBeTruthy(), {timeout: 10_000});
    fireEvent.press(screen.getByTestId(`sidebar-row-dm:${DM_SEO}`));
    await waitFor(() => expect(screen.getByTestId('header-back')).toBeTruthy(), {timeout: 10_000});
    await untilCursorLands(server, 0);
    await goBack();

    fireEvent.press(screen.getByTestId('tab-inbox'));
    await waitFor(() => expect(dots()).toEqual([]), {timeout: 10_000});
    // 목록은 다시 읽혔고(탭이 보이게 됨) 그래도 낡은 답이었다.
    expect(inboxGets(server).length).toBeGreaterThanOrEqual(2);
  });

  it('위치가 아직 못 미친 항목은 점이 남는다 (위치 아래만 읽음이다)', async () => {
    const server = dmServer([1, 2, 3]);
    await showInboxWith(server, 3);
    // 위치가 2까지만 간다(서버는 항목 1·2를 읽음으로 채우고, 폰의 목록은 낡은 채다).
    server.frozenList = server.items.map(item => ({...item}));
    fireEvent.press(screen.getByTestId('tab-home'));
    await waitFor(() => expect(screen.getByTestId(`sidebar-row-dm:${DM_SEO}`)).toBeTruthy(), {timeout: 10_000});
    advanceCursor(server, DM_SEO, 2);
    // 홈이 위치 투영을 다시 읽게 한다: 대화를 열어 보내는 대신 서버 쪽에서 움직인 위치가 투영에 닿는 길(30초 주기)을 흉내 낸다.
    await act(async () => {
      await queryClient?.invalidateQueries({queryKey: ['read-state']});
    });
    fireEvent.press(screen.getByTestId('tab-inbox'));
    await waitFor(() => expect(dots()).toEqual(['mailbox-unread-inbox:item-3']), {timeout: 10_000});
  });

  it('다른 기기가 항목 하나만 읽음으로 누른 것은 받은함 탭을 다시 열면 점이 없다 (채널 위치는 그대로)', async () => {
    const server = dmServer([1, 2]);
    await showInboxWith(server, 2);
    expect(dots()).toHaveLength(2);

    // 데스크탑에서 항목 2만 「읽음」으로 눌렀다: 서버의 위치는 안 움직이므로 폰이 알 길은 목록을 다시 읽는 것뿐이다.
    readItemOnly(server, 'ITEM-2');
    expect(server.cursor[DM_SEO]).toBe(0);

    fireEvent.press(screen.getByTestId('tab-home'));
    fireEvent.press(screen.getByTestId('tab-inbox'));
    await waitFor(() => expect(dots()).toEqual(['mailbox-unread-inbox:item-1']), {timeout: 10_000});
  });

  it('앱이 앞으로 돌아오면 보이는 받은함이 다시 읽힌다 (다른 기기의 항목 읽음이 폰을 켜면 보인다)', async () => {
    const server = dmServer([1, 2]);
    await showInboxWith(server, 2);
    expect(dots()).toHaveLength(2);
    const before = inboxGets(server).length;

    readItemOnly(server, 'ITEM-2');
    // `installReactQueryBridges`가 앱 상태를 이 포커스에 이어 둔다: 백그라운드로 갔다가 앞으로 돌아온다.
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(inboxGets(server).length).toBeGreaterThan(before), {timeout: 10_000});
    await waitFor(() => expect(dots()).toEqual(['mailbox-unread-inbox:item-1']), {timeout: 10_000});
  });
});
