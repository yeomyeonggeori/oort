import type {Member} from '@momo/core/lib/api';
import {
  MARK_ABOVE_CURSOR,
  MARK_AT_3_CURSOR_10,
  MARK_UNREAD_PROOF_CHANNEL_ID,
  markAboveCursor,
  markAt3Cursor10,
} from '@momo/core/features/readState/proof';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {centrifugoChannelName} from '@momo/core/lib/realtimeEvents';
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
import {readdirSync, readFileSync, statSync} from 'fs';
import {join, relative} from 'path';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {
  readIntentWire,
  visitFlushReason,
} from '../src/features/readState/advertise';
import {
  carriesMark,
  foldVisitBoundary,
} from '../src/features/readState/visit';
import {createQueryClient} from '../src/query/queryClient';
import {buildSidebarSections} from '../src/features/sidebar/rows';
import InboxScreen from '../src/screens/InboxScreen';
import AppShell from '../src/shell/AppShell';
import {SessionProvider} from '../src/session/useSession';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// 폰이 「여기부터 안 읽음」을 소비한다 (ADR-0178 D3·D6, #1964)
//
// 데스크탑이 건 마크는 서버의 `unread_count` 에 접히지 않는다. 그래서 그 숫자를
// 그대로 읽는 폰은 사람이 「다시 오겠다」고 표시한 바로 그 채널을 **다 읽음**으로
// 그렸다. 이 파일은 그 결함의 세 얼굴을 잰다:
//
//   1. 사이드바 행의 배지 — 코어 `composedUnreadCount` 를 거쳐야 8 이다(서버는 0).
//   2. 대화의 안읽음 구분선 — `unreadDividerCursorSeq` 를 거쳐야 seq 3 위에 선다.
//   3. 채널을 연 광고 — `read_intent: "explicit_open"` 을 실어야 서버가 마크를
//      지운다. 연 채로 도착한 광고와 인박스의 멘션 읽음은 싣지 않는다.
//
// 픽스처는 코어의 공용 레드 프루프(`features/readState/proof.ts`)다: 마크 3 ·
// 커서 10 · head 10 · 서버 `unread_count` 0. 웹의 `markUnread.surfaces.test.ts` 가
// 같은 한 점에서 배지·구분선·필·⌥↑↓ 를 맞추므로, 폰도 **같은 점**에서 맞춘다.
//
// 가짜로 두는 것은 `fetch` 가 무엇을 답했는가와 소켓이 무엇을 실어 왔는가 둘뿐이다
// (`conversationRenders.test.tsx` 와 같은 규율). 서버 쪽은 D4 를 흉내 낸다: 명시
// 열람이 실린 PUT 은 같은 tx 에서 마크를 지우고, 그 뒤의 조회는 마크 없이 온다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const KIM_AGENT = 'cccccccc-1111-4111-8111-cccccccccccc';
/** 코어 레드 프루프의 채널. 같은 id 여야 같은 점을 재는 것이다. */
const CH = MARK_UNREAD_PROOF_CHANNEL_ID;
const BASE = 'https://api.example.com';
const BASE_MS = 1_700_000_000_000;

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

const ROSTER = [
  rosterMember({id: SELF_ID, displayName: '곽성재', handle: 'seongjae'}),
  rosterMember({
    id: KIM_AGENT,
    kind: 'agent',
    displayName: '김인턴',
    handle: 'kim-intern',
    channelCount: 1,
    channelIds: [CH],
  }),
];

const CHANNELS = [
  {id: CH, workspaceId: WS, kind: 'public', name: 'general', muted: false},
];

function restMessage(seq: number, over: Record<string, unknown> = {}) {
  return {
    id: `msg-${seq}`,
    channelId: CH,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: KIM_AGENT,
    type: 'text',
    body: `${seq}번째 메시지`,
    state: 'sent',
    createdAtMs: BASE_MS + seq * 1000,
    ...over,
  };
}

function framePayload(seq: number) {
  return {
    id: `msg-${seq}`,
    channel_id: CH,
    seq,
    type: 'text',
    body: `${seq}번째 메시지`,
    author_member_id: KIM_AGENT,
    hlc_ts: seq,
    hlc_count: 0,
    created_at_ms: BASE_MS + seq * 1000,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

// ---- the server, as far as this ticket can see it ---------------------------

interface ReadStateServer {
  cursor: number;
  head: number;
  mark: number | null;
  mentionCount: number;
  /** Every PUT body, in order. */
  puts: Record<string, unknown>[];
  /** GET /read-state answers so far. */
  gets: number;
  /** Hold the NEXT read-state GET until this is called (cold start). */
  holdNextGet: boolean;
  releaseHeldGet: (() => void) | null;
  /**
   * What the phone's list held at the moment each `explicit_open` reached the
   * server — the 「먼저 그리고 그다음 지운다」 assertion, read at the only instant
   * it means anything rather than inferred from the order of later states.
   */
  dividerAtExplicitOpen: ({count: number; beforeSeq: number | null} | null | 'no-list')[];
}

let server: ReadStateServer;

function wireRow() {
  return {
    channel_id: CH,
    last_read_seq: server.cursor,
    latest_seq: server.head,
    // The server does NOT fold the mark (PR #1961). With cursor = head this is 0
    // whatever the mark says — the exact number a raw consumer prints.
    unread_count: Math.max(0, server.head - server.cursor),
    mention_count: server.mentionCount,
    marked_unread_before_seq: server.mark,
  };
}

let history = Array.from({length: 10}, (_, i) => restMessage(i + 1));

function installFetch(): jest.Mock {
  const mock = jest.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url.includes('/read-state')) {
      if (method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        server.puts.push(body);
        const requested = Number(body.last_read_seq);
        server.cursor = Math.max(server.cursor, Math.min(requested, server.head));
        // D4/D6: only an explicit open clears the mark, and it does so in the
        // same transaction that advanced the cursor.
        if (body.read_intent === 'explicit_open') {
          server.dividerAtExplicitOpen.push(dividerNow());
          server.mark = null;
        }
        return jsonResponse(200, wireRow());
      }
      server.gets += 1;
      if (server.holdNextGet) {
        server.holdNextGet = false;
        await new Promise<void>(resolve => {
          server.releaseHeldGet = resolve;
        });
      }
      return jsonResponse(200, {read_states: [wireRow()]});
    }
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/messages')) {
      // The inbox asks for what is above the cursor; the timeline for the head
      // page. Both are this channel's log.
      const after = /[?&]after=(\d+)/.exec(url);
      if (after) {
        const from = Number(after[1]);
        return jsonResponse(200, {
          messages: history.filter(message => message.seq > from),
        });
      }
      return jsonResponse(200, {messages: history});
    }
    if (url.includes('/channels')) return jsonResponse(200, {channels: CHANNELS});
    if (url.includes('/roster')) return jsonResponse(200, {members: ROSTER});
    if (url.includes('/work-sessions')) return jsonResponse(200, {workSessions: []});
    if (url.includes('/work-hosts')) return jsonResponse(200, {workHosts: []});
    if (url.includes('/profile')) {
      return jsonResponse(403, {error: {message: 'agent owner required'}});
    }
    if (url.includes('/allowed-models')) {
      return jsonResponse(200, {allowedAgentModels: []});
    }
    if (url.includes('/inbox') || url.includes('/approvals') || url.includes('/runs')) {
      return jsonResponse(200, {mentions: [], approvals: [], items: [], runs: []});
    }
    throw new Error(`unrouted request: ${method} ${url}`);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

interface FakeSubscription {
  __emit: (event: string, ctx: unknown) => void;
}

const centrifugeMock = jest.requireMock('centrifuge') as {
  __clients: {getSubscription: (name: string) => FakeSubscription | null}[];
  __reset: () => void;
};

function channelSub(): FakeSubscription | null {
  const clients = centrifugeMock.__clients;
  const last = clients[clients.length - 1];
  return last?.getSubscription(centrifugoChannelName(WS, CH)) ?? null;
}

const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;

let queryClient: QueryClient | null = null;

function newClient(): QueryClient {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {retry: false, gcTime: 0},
      mutations: {retry: false, gcTime: 0},
    },
  });
  return queryClient;
}

async function settle(ms = 25) {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
}

async function mountShell() {
  render(
    <QueryClientProvider client={newClient()}>
      <AppShell member={SELF} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
}

async function openChannel() {
  fireEvent.press(screen.getByTestId(`sidebar-row-channel:${CH}`));
  await waitFor(() => expect(screen.getByTestId('timeline-list')).toBeTruthy());
  await waitFor(() =>
    expect(screen.getAllByTestId('message-row').length).toBeGreaterThan(0),
  );
}

interface StreamItem {
  kind: string;
  count?: number;
  message?: {seq: number};
}

/** The divider right now, or `'no-list'` when no timeline is mounted. */
function dividerNow(): {count: number; beforeSeq: number | null} | null | 'no-list' {
  return screen.queryByTestId('timeline-list') === null ? 'no-list' : dividerInList();
}

/** The phone's own query client — 30s staleTime, no refetch on focus. */
async function mountShellWith(client: QueryClient) {
  queryClient = client;
  render(
    <QueryClientProvider client={client}>
      <AppShell member={SELF} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
}

/** Where the list put the unread line, read off the data the list is holding. */
function dividerInList(): {count: number; beforeSeq: number | null} | null {
  const items = screen.getByTestId('timeline-list').props.data as StreamItem[];
  const at = items.findIndex(item => item.kind === 'unread');
  if (at < 0) return null;
  const next = items.slice(at + 1).find(item => item.kind === 'message');
  return {count: items[at].count ?? -1, beforeSeq: next?.message?.seq ?? null};
}

beforeEach(() => {
  mmkvStore.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  centrifugeMock.__reset();
  sessionPort.applyLogin(LOGIN_BODY);
  history = Array.from({length: 10}, (_, i) => restMessage(i + 1));
  // The shared red proof: mark 3, cursor 10, head 10, server count 0.
  server = {
    cursor: markAt3Cursor10().lastReadSeq,
    head: markAt3Cursor10().latestSeq,
    mark: markAt3Cursor10().markedUnreadBeforeSeq,
    mentionCount: 0,
    puts: [],
    gets: 0,
    holdNextGet: false,
    releaseHeldGet: null,
    dividerAtExplicitOpen: [],
  };
  installFetch();
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
});

// ---- 1. the row, as a pure function -----------------------------------------

describe('사이드바 행은 D3 합성 수를 그린다 — 서버 unread_count 가 아니라', () => {
  const directory = makeDirectory([]);
  const channel = {id: CH, workspaceId: WS, kind: 'public' as const, name: 'general', muted: false};

  function rowFor(read: ReturnType<typeof markAt3Cursor10>, openChannelId: string | null = null) {
    const sections = buildSidebarSections({
      groups: {channels: [channel], dms: []},
      agents: [],
      directory,
      selfMemberId: SELF_ID,
      unreadByChannel: new Map([[CH, read]]),
      openChannelId,
      query: '',
    });
    return sections[0]?.data[0];
  }

  it('데스크탑이 마크한 채널(마크 3 · 커서 10 · head 10)은 8개 안 읽음이다', () => {
    const read = markAt3Cursor10();
    // The premise, stated: the server's own number is 0.
    expect(read.unreadCount).toBe(0);
    const row = rowFor(read);
    expect(row?.unreadCount).toBe(MARK_AT_3_CURSOR_10.count);
    expect(row?.accessibilityLabel).toBe('채널 general, 안 읽은 메시지 8개');
  });

  it('마크가 커서보다 위면 수를 넓히지 않는다 (D3 의 min)', () => {
    expect(rowFor(markAboveCursor())?.unreadCount).toBe(MARK_ABOVE_CURSOR.count);
  });

  it('지금 읽고 있는 채널은 마크가 있어도 배지를 내린다', () => {
    expect(rowFor(markAt3Cursor10(), CH)?.unreadCount).toBe(0);
  });
});

// ---- 2. the wire discriminator, as pure functions ----------------------------

describe('read_intent 판별 (D6)', () => {
  it('명시 열람만 explicit_open 을 싣는다 — background 는 문자열로 보내지 않는다', () => {
    expect(readIntentWire('channel_open')).toBe('explicit_open');
    expect(readIntentWire('arrival_flush')).toBeUndefined();
    expect(readIntentWire('inbox_mention')).toBeUndefined();
  });

  it('방문의 첫 광고만, 그리고 이 방문의 응답으로 경계를 그린 뒤에만 명시 열람이다', () => {
    expect(visitFlushReason({explicitOpenSent: false, freshBoundary: true})).toBe(
      'channel_open',
    );
    expect(visitFlushReason({explicitOpenSent: true, freshBoundary: true})).toBe(
      'arrival_flush',
    );
    // 이 방문의 응답을 아직 못 받았으면 지금 마크를 그린 적이 없다. 지우지 않는다.
    expect(visitFlushReason({explicitOpenSent: false, freshBoundary: false})).toBe(
      'arrival_flush',
    );
  });
});

describe('방문 경계 접기 (#1964 R1 H-1 — 웹 foldInVisitMark 방향)', () => {
  const unmarked = {...markAt3Cursor10(), markedUnreadBeforeSeq: null};

  it('마크는 합성이 쓴 경우에만 「실렸다」 — 커서 뒤의 마크는 D3 의 min 이 버린다', () => {
    expect(carriesMark(markAt3Cursor10())).toBe(true);
    expect(carriesMark(unmarked)).toBe(false);
    expect(carriesMark(markAboveCursor())).toBe(false);
  });

  it('처음 본 행으로 얼리고, 행이 없으면 경계도 없다', () => {
    expect(foldVisitBoundary(null, CH, null)).toBeNull();
    expect(foldVisitBoundary(null, CH, unmarked)).toEqual({
      channelId: CH,
      lastReadSeq: 10,
      unreadCount: 0,
    });
  });

  it('얼린 뒤에 마크를 싣고 온 행이 경계를 대신한다 — 캐시로 연 방문 (H-1)', () => {
    const atOpen = foldVisitBoundary(null, CH, unmarked);
    expect(foldVisitBoundary(atOpen, CH, markAt3Cursor10())).toEqual({
      channelId: CH,
      lastReadSeq: MARK_AT_3_CURSOR_10.dividerCursor,
      unreadCount: MARK_AT_3_CURSOR_10.count,
    });
  });

  it('마크 없는 행은 경계를 지우지 않는다 — 이 방문의 명시 열람이 방금 지운 것', () => {
    const drawn = foldVisitBoundary(null, CH, markAt3Cursor10());
    expect(foldVisitBoundary(drawn, CH, unmarked)).toBe(drawn);
  });

  it('다른 기기의 나중 마크는 구분선을 그리로 옮긴다', () => {
    const drawn = foldVisitBoundary(null, CH, markAt3Cursor10());
    const later = foldVisitBoundary(drawn, CH, {
      ...markAt3Cursor10(),
      markedUnreadBeforeSeq: 7,
    });
    expect(later).toEqual({channelId: CH, lastReadSeq: 6, unreadCount: 4});
  });

  it('다른 방으로 옮기면 그 방의 행으로 새로 얼린다', () => {
    const drawn = foldVisitBoundary(null, CH, markAt3Cursor10());
    expect(foldVisitBoundary(drawn, 'another-room', null)).toBeNull();
  });
});

// ---- 3. the shipping tree ---------------------------------------------------

describe('데스크탑에서 마크한 채널이 폰에서도 안 읽음으로 보인다 (배송되는 트리)', () => {
  it('사이드바 배지가 서버의 0 이 아니라 8 을 말한다', async () => {
    await mountShell();
    await settle();
    const row = screen.getByTestId(`sidebar-row-channel:${CH}`);
    expect(row.props.accessibilityLabel).toBe('채널 general, 안 읽은 메시지 8개');
    // 배지는 스스로 라벨을 들지 않는다(행이 한 접근성 원소다, DS2-3). 보이는 수가 8이다.
    expect(within(row).getByTestId('home-badge-unread')).toHaveTextContent('8');
  });

  it('대화의 구분선이 마크 자리(seq 3 위)에 「새 메시지 8개」로 선다', async () => {
    await mountShell();
    await openChannel();
    await settle();

    expect(dividerInList()).toEqual({count: 8, beforeSeq: 3});
    expect(
      within(screen.getByTestId('unread-divider')).getByText(
        '새 메시지 8개, 여기까지 읽음',
      ),
    ).toBeTruthy();
  });

  it('채널을 연 첫 커서 PUT 은 read_intent: "explicit_open" 을 싣는다', async () => {
    await mountShell();
    await openChannel();
    await settle(700);

    expect(server.puts.length).toBeGreaterThan(0);
    expect(server.puts[0]).toEqual({
      last_read_seq: 10,
      read_intent: 'explicit_open',
    });
    // 서버가 같은 tx 에서 마크를 지웠다 (D4).
    expect(server.mark).toBeNull();
  });

  it('명시 열람이 서버 마크를 지운 뒤에도 이 방문의 구분선은 그대로다', async () => {
    await mountShell();
    await openChannel();
    const getsBefore = server.gets;
    await settle(700);
    // The PUT's own invalidation re-reads the projection, which now says
    // "unmarked, nothing unread". That answer must not reach this visit's line.
    await waitFor(() => expect(server.gets).toBeGreaterThan(getsBefore));
    await settle();

    expect(server.mark).toBeNull();
    expect(dividerInList()).toEqual({count: 8, beforeSeq: 3});
  });

  it('연 채로 도착한 메시지의 광고는 read_intent 를 싣지 않는다 — 마크가 살아야 할 길이다', async () => {
    await mountShell();
    await openChannel();
    await settle(700);
    expect(server.puts[0]?.read_intent).toBe('explicit_open');
    const before = server.puts.length;

    history = [...history, restMessage(11)];
    server.head = 11;
    await act(async () => {
      channelSub()?.__emit('publication', {
        data: {
          type: 'message.new',
          v: 1,
          ts: BASE_MS + 11_000,
          seq: 11,
          payload: framePayload(11),
        },
      });
    });
    await settle(700);

    const arrivals = server.puts.slice(before);
    expect(arrivals.length).toBeGreaterThan(0);
    for (const body of arrivals) {
      expect(body).not.toHaveProperty('read_intent');
    }
    expect(arrivals[arrivals.length - 1]).toEqual({last_read_seq: 11});
  });

  it('읽음 투영보다 먼저 나간 광고는 background 이고, 투영이 오면 명시 열람이 뒤따른다', async () => {
    // Cold start from a push: the conversation is open before the projection has
    // ever answered. An explicit open sent then would delete a mark this screen
    // has not drawn yet.
    server.holdNextGet = true;
    await mountShell();
    await openChannel();
    await settle(700);

    expect(server.puts.length).toBeGreaterThan(0);
    for (const body of server.puts) {
      expect(body).not.toHaveProperty('read_intent');
    }
    expect(server.mark).toBe(3);
    expect(dividerInList()).toBeNull();

    await act(async () => {
      server.releaseHeldGet?.();
    });
    await settle(700);

    // The boundary froze WITH the mark, and only then was the mark cleared.
    expect(dividerInList()).toEqual({count: 8, beforeSeq: 3});
    const last = server.puts[server.puts.length - 1];
    expect(last).toEqual({last_read_seq: 10, read_intent: 'explicit_open'});
    expect(server.mark).toBeNull();
    expect(server.dividerAtExplicitOpen).toEqual([{count: 8, beforeSeq: 3}]);
  });
});

// ---- 4. the warm start: the phone already holds a projection ---------------
//
// design-review 2593 R1 H-1. The cold start above is the easy case — nothing is
// cached, so nothing can be stale. What a person actually does is resume the app,
// or tap a push while it is open, and then the phone holds a read state it
// fetched earlier. The desktop marks the channel in between. The first version
// took that cache as 「seen」, froze the divider from it, and sent explicit_open
// — clearing a mark the screen never drew.
//
// Both tests run on the phone's OWN query client (`createQueryClient`: 30s
// staleTime, no refetch on focus). The review's point was precisely that the
// suite's `staleTime: 0` client never produced this state.

describe('캐시를 들고 연 방에서도 마크는 먼저 그려지고 그다음 지워진다 (#1964 R1 H-1)', () => {
  it('A. 60초 묵은 캐시(앱 재개·푸시 탭): 이 방문의 응답 전에는 지우지 않고, 응답이 마크를 그린 뒤에 지운다', async () => {
    server.mark = null; // the phone caches this; the desktop has not marked yet
    const client = createQueryClient();
    await mountShellWith(client);
    await settle();
    server.mark = 3; // now the desktop marks 「여기부터 안 읽음」 at seq 3
    client
      .getQueryCache()
      .find({queryKey: ['read-state', WS]})
      ?.setState({dataUpdatedAt: Date.now() - 60_000});
    // The visit's own answer is slower than the first cursor flush.
    server.holdNextGet = true;

    await openChannel();
    await settle(700);

    // First flush went out before this visit had an answer: cursor only.
    expect(server.puts[0]).toEqual({last_read_seq: 10});
    expect(server.dividerAtExplicitOpen).toEqual([]);

    await settle(700);

    // The explicit open went out, and at that instant the divider stood at the mark.
    expect(server.dividerAtExplicitOpen).toEqual([{count: 8, beforeSeq: 3}]);
    expect(server.puts.at(-1)).toEqual({
      last_read_seq: 10,
      read_intent: 'explicit_open',
    });
    expect(server.mark).toBeNull();

    await act(async () => {
      server.releaseHeldGet?.();
    });
    await settle(100);
    // …and the cleared server does not take the line down under the reader.
    expect(dividerInList()).toEqual({count: 8, beforeSeq: 3});
  });

  it('B. 30초보다 젊은 캐시: 방문이 응답을 청하고, 첫 광고가 그 응답이 그린 마크를 지운다', async () => {
    server.mark = null;
    const client = createQueryClient();
    await mountShellWith(client);
    await settle();
    server.mark = 3;
    const getsBeforeOpen = server.gets;

    await openChannel();
    await settle(700);

    // The cache was fresh, so nothing but the visit itself asked again.
    expect(server.gets).toBeGreaterThan(getsBeforeOpen);
    // The FIRST advertisement is already the explicit open — and the divider was
    // on screen when it arrived.
    expect(server.puts[0]).toEqual({last_read_seq: 10, read_intent: 'explicit_open'});
    expect(server.dividerAtExplicitOpen).toEqual([{count: 8, beforeSeq: 3}]);
    expect(server.mark).toBeNull();
    await settle(100);
    expect(dividerInList()).toEqual({count: 8, beforeSeq: 3});
  });
});

describe('인박스의 멘션 읽음은 채널을 연 것이 아니다', () => {
  it('「읽음」 PUT 은 read_intent 를 싣지 않는다 — 데스크탑의 마크는 산다', async () => {
    server.cursor = 8;
    server.mentionCount = 1;
    history = history.map(message =>
      message.seq === 9
        ? {...message, props: {mention_member_ids: [SELF_ID]}}
        : message,
    );
    render(
      <QueryClientProvider client={newClient()}>
        <SessionProvider member={SELF}>
          <InboxScreen onOpenConversation={() => {}} />
        </SessionProvider>
      </QueryClientProvider>,
    );
    const tab = await screen.findByTestId('inbox-tab-mentions').catch(() => null);
    if (tab) fireEvent.press(tab);
    const button = await screen.findByTestId('mark-read-mention:msg-9');
    fireEvent.press(button);
    await settle(50);

    expect(server.puts).toEqual([{last_read_seq: 9}]);
    expect(server.mark).toBe(3);
  });
});

// ---- 4. the phone composes nothing itself -----------------------------------

describe('폰은 마크 필드를 이름으로 부르지 않는다 (D3 단일점, 레드 프루프 ④의 폰 판)', () => {
  // The web gate (`markUnread.compositionGate.test.ts`) walks the core and the web
  // tree with the TypeScript AST, because both of them legitimately carry the
  // field. The phone does not: every consumer here hands the whole row to a core
  // function. So its rule can be the stricter, simpler one — the field is not
  // named anywhere under `src/`, and composing it would first require naming it.
  const SRC = join(__dirname, '..', 'src');
  const FIELD = /\bmarked(?:UnreadBeforeSeq|_unread_before_seq)\b/;

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }

  it('src/ 어디에도 마크 필드가 없다', () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(50);
    const hits = files
      .filter(file => FIELD.test(readFileSync(file, 'utf8')))
      .map(file => relative(SRC, file));
    expect(hits).toEqual([]);
  });

  it('게이트가 실제로 잡는다 — 한 줄 합성을 넣으면 걸린다', () => {
    expect(
      FIELD.test('const start = Math.min(read.markedUnreadBeforeSeq ?? 0, 1);'),
    ).toBe(true);
    expect(FIELD.test('body.marked_unread_before_seq')).toBe(true);
    expect(FIELD.test('markUnreadBeforeSeq: seq')).toBe(false);
  });
});
