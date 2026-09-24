import type {Member} from '@momo/core/lib/api';
import {markAt3Cursor10} from '@momo/core/features/readState/proof';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import * as Notifications from 'expo-notifications';
import React from 'react';
import {AppState} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// 앱 아이콘 배지가 서버의 안읽음 합계를 따른다 (#2670, ADR-0109).
//
// 배지 숫자는 relay 가 푸시마다 싣는다. 서버가 계산한 값이다(`momo-push`
// `judgment.rs` `unread_badge`). 앱은 그 숫자를 한 번도 고치지 않았다. 그래서
// 읽어도 아이콘은 다음 푸시가 올 때까지 그대로였다. 시뮬레이터 실측(Release):
// 푸시 badge 5 → #배포를 읽음(서버 2) → #로그를 읽음(서버 0) → 35초 뒤에도
// 아이콘 값은 「5개의 새로운 항목」이었다.
//
// 이 파일이 재는 것은 배지 API 에 **실제로 건넨 값**이다. 가짜는 셋이다: 서버의
// 답(`fetch`), expo 의 네이티브 쪽(`setBadgeCountAsync` 는 호출만 기록한다), 그리고
// `AppState` 전이. 셸·사이드바·대화 화면·읽음 커서는 전부 진짜다.
//
// 가짜 서버의 읽음 투영은 서버와 같은 식이다: 방마다 `max(head − cursor, 0)`.
// 마크(ADR-0178)는 싣기만 하고 수에 접지 않는다(PR #1961). `serverBadge()` 는
// 다음 푸시가 실을 숫자이고, `judgment.rs` 의 SQL 과 같은 합이다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const KIM_AGENT = 'cccccccc-1111-4111-8111-cccccccccccc';
const BASE = 'https://api.example.com';
const BASE_MS = 1_700_000_000_000;

const GENERAL = '33333333-3333-4333-8333-333333333333';
const RANDOM = '44444444-3333-4333-8333-444444444444';
const QUIET = '55555555-3333-4333-8333-555555555555';

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
    channelCount: 3,
    channelIds: [GENERAL, RANDOM, QUIET],
  }),
];

const CHANNELS = [
  {id: GENERAL, workspaceId: WS, kind: 'public', name: 'general', muted: false},
  {id: RANDOM, workspaceId: WS, kind: 'public', name: 'random', muted: false},
  {id: QUIET, workspaceId: WS, kind: 'public', name: 'quiet', muted: false},
];

// ---- the server, as far as the badge can see it -----------------------------

interface Room {
  head: number;
  cursor: number;
  mark: number | null;
}

interface Server {
  rooms: Map<string, Room>;
  /** GET /read-state answers so far. */
  gets: number;
  /** Hold the NEXT read-state GET until released (cold start). */
  holdNextGet: boolean;
  releaseHeldGet: (() => void) | null;
}

let server: Server;

function room(channelId: string): Room {
  const found = server.rooms.get(channelId);
  if (found === undefined) throw new Error(`no room ${channelId}`);
  return found;
}

/** The number the next push would carry: `unread_badge`'s sum, same terms. */
function serverBadge(): number {
  let total = 0;
  for (const {head, cursor} of server.rooms.values()) {
    total += Math.max(head - cursor, 0);
  }
  return total;
}

function wireRow(channelId: string) {
  const {head, cursor, mark} = room(channelId);
  return {
    channel_id: channelId,
    last_read_seq: cursor,
    latest_seq: head,
    unread_count: Math.max(head - cursor, 0),
    mention_count: 0,
    marked_unread_before_seq: mark,
  };
}

function restMessage(channelId: string, seq: number) {
  return {
    id: `msg-${channelId.slice(0, 4)}-${seq}`,
    channelId,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: KIM_AGENT,
    type: 'text',
    body: `${seq}번째 메시지`,
    state: 'sent',
    createdAtMs: BASE_MS + seq * 1000,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function channelOf(url: string): string {
  return (url.split('/channels/')[1]?.split('/')[0] ?? '').toLowerCase();
}

function installFetch(): jest.Mock {
  const mock = jest.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url.includes('/read-state')) {
      if (method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const target = room(channelOf(url));
        target.cursor = Math.max(
          target.cursor,
          Math.min(Number(body.last_read_seq), target.head),
        );
        if (body.read_intent === 'explicit_open') target.mark = null;
        return jsonResponse(200, wireRow(channelOf(url)));
      }
      server.gets += 1;
      if (server.holdNextGet) {
        server.holdNextGet = false;
        await new Promise<void>(resolve => {
          server.releaseHeldGet = resolve;
        });
      }
      return jsonResponse(200, {
        read_states: CHANNELS.map(channel => wireRow(channel.id)),
      });
    }
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/pins')) return jsonResponse(200, {pins: []});
    if (url.includes('/messages')) {
      const channelId = channelOf(url);
      const history = Array.from({length: room(channelId).head}, (_, i) =>
        restMessage(channelId, i + 1),
      );
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

// ---- the native side: what the icon was told -------------------------------

const setBadge = Notifications.setBadgeCountAsync as unknown as jest.Mock;

/** Every value handed to the badge API, in order. */
function badgeWrites(): number[] {
  return setBadge.mock.calls.map(call => call[0] as number);
}

function lastBadge(): number | undefined {
  const writes = badgeWrites();
  return writes[writes.length - 1];
}

/** The writes with repeats of the same value folded. */
function badgeSequence(): number[] {
  return badgeWrites().filter((value, at, all) => at === 0 || all[at - 1] !== value);
}

// ---- AppState, by hand ---------------------------------------------------------

/**
 * RN 의 jest preset 은 `AppState.addEventListener` 를 이미 `jest.fn` 으로 둔다.
 * `jest.spyOn` 은 그 같은 함수를 돌려주므로 `mockRestore()` 는 preset 의 구현까지
 * 지운다 — 그 뒤의 시험에서 구독이 `undefined` 가 되어 언마운트가 터진다. 그래서
 * preset 의 구현을 한 번 잡아 두고 시험마다 되돌린다.
 */
const appStateListen = AppState.addEventListener as unknown as jest.Mock;
const presetAppStateListen = appStateListen.getMockImplementation();

/**
 * `AppState` 전이를 손으로 낸다. RN 0.86 의 jest mock 은 `emit` 을 내놓지 않으므로
 * 구독 자체를 가로챈다(`pushTap.test.tsx` 의 같은 도구). 렌더 **전에** 걸어야 한다.
 */
function captureAppState(): (status: string) => void {
  const handlers: ((status: string) => void)[] = [];
  appStateListen.mockImplementation(((
    _event: string,
    fn: (status: string) => void,
  ) => {
    handlers.push(fn);
    return {
      remove: () => {
        const at = handlers.indexOf(fn);
        if (at >= 0) handlers.splice(at, 1);
      },
    };
  }) as never);
  return status => {
    act(() => {
      for (const fn of [...handlers]) fn(status);
    });
  };
}

// ---- rendering ------------------------------------------------------------------

const centrifugeMock = jest.requireMock('centrifuge') as {__reset: () => void};
const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;

let queryClient: QueryClient | null = null;

async function settle(ms = 25) {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
}

async function mountShell() {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {retry: false, gcTime: 0},
      mutations: {retry: false, gcTime: 0},
    },
  });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <AppShell member={SELF} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
  return rendered;
}

/** Open a room the way a person does, and wait until the phone has read it. */
async function readRoom(channelId: string) {
  fireEvent.press(screen.getByTestId(`sidebar-row-channel:${channelId}`));
  await waitFor(() => expect(screen.getByTestId('timeline-list')).toBeTruthy());
  await waitFor(() => expect(room(channelId).cursor).toBe(room(channelId).head));
}

async function leaveRoom() {
  fireEvent.press(screen.getByTestId('header-back'));
  await waitFor(() => expect(screen.queryByTestId('timeline-list')).toBeNull());
}

beforeEach(() => {
  mmkvStore.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  centrifugeMock.__reset();
  sessionPort.applyLogin(LOGIN_BODY);
  // #general 3 · #random 2 · #quiet 0 unread → the server badge is 5.
  server = {
    rooms: new Map([
      [GENERAL, {head: 8, cursor: 5, mark: null}],
      [RANDOM, {head: 6, cursor: 4, mark: null}],
      [QUIET, {head: 4, cursor: 4, mark: null}],
    ]),
    gets: 0,
    holdNextGet: false,
    releaseHeldGet: null,
  };
  installFetch();
  setBadge.mockClear();
});

afterEach(async () => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  appStateListen.mockImplementation(presetAppStateListen);
  // Unmounting writes 0 (sign-out). Let that write land here rather than in the
  // next test's record.
  await new Promise(resolve => setTimeout(resolve, 0));
});

describe('앱 아이콘 배지는 서버의 안읽음 합계를 따른다 (#2670)', () => {
  it('첫 읽음 투영이 오기 전에는 아이콘을 건드리지 않고, 오면 서버 합계를 적는다', async () => {
    // A cold start opened by a push: the icon already says what the push said.
    // Writing anything before the server answers would replace a true number
    // with a guess.
    server.holdNextGet = true;
    await mountShell();
    await settle(50);
    expect(badgeWrites()).toEqual([]);

    await act(async () => server.releaseHeldGet?.());
    await waitFor(() => expect(badgeWrites()).toEqual([serverBadge()]));
    expect(serverBadge()).toBe(5);
  });

  it('방을 열어 읽으면 줄이고, 다 읽으면 0 으로 지운다', async () => {
    await mountShell();
    await waitFor(() => expect(lastBadge()).toBe(5));

    await readRoom(GENERAL);
    expect(serverBadge()).toBe(2);
    await waitFor(() => expect(lastBadge()).toBe(2));

    await leaveRoom();
    await readRoom(RANDOM);
    expect(serverBadge()).toBe(0);
    await waitFor(() => expect(lastBadge()).toBe(0));

    expect(badgeSequence()).toEqual([5, 2, 0]);
  });

  it('다른 기기에서 읽은 것은 앞으로 돌아올 때 다시 물어 반영한다', async () => {
    const emit = captureAppState();
    await mountShell();
    await waitFor(() => expect(lastBadge()).toBe(5));

    emit('background');
    // Read on the desktop while the phone was away.
    room(GENERAL).cursor = room(GENERAL).head;
    const gets = server.gets;
    emit('active');

    await waitFor(() => expect(server.gets).toBeGreaterThan(gets));
    await waitFor(() => expect(lastBadge()).toBe(2));
  });

  it('같은 수여도 돌아올 때마다 다시 적는다 — 그 사이 푸시가 아이콘을 바꿨을 수 있다', async () => {
    // The icon is not ours alone: a push that arrived while the phone was away
    // wrote its own number. The sum did not move, so a write-on-change would
    // leave the push's number standing.
    const emit = captureAppState();
    await mountShell();
    await waitFor(() => expect(lastBadge()).toBe(5));
    await settle(50);
    const writes = badgeWrites().length;

    emit('background');
    // iOS may pass through `inactive` on the way back to the foreground.
    emit('inactive');
    emit('active');

    await waitFor(() => expect(badgeWrites().length).toBeGreaterThan(writes));
    expect(lastBadge()).toBe(5);
  });

  it('배너·알림 센터(inactive)에서 돌아온 것은 다시 묻지 않는다', async () => {
    // A banner alone cycles focus (queryClient.ts); that is not a return from
    // being away, and nothing could have moved the icon in between.
    const emit = captureAppState();
    await mountShell();
    await waitFor(() => expect(lastBadge()).toBe(5));
    await settle(50);
    const gets = server.gets;
    const writes = badgeWrites().length;

    emit('inactive');
    emit('active');
    await settle(50);

    expect(server.gets).toBe(gets);
    expect(badgeWrites().length).toBe(writes);
  });

  it('로그아웃으로 셸이 내려가면 0 으로 지운다 — 앞 사람의 수가 아이콘에 남지 않게', async () => {
    const {unmount} = await mountShell();
    await waitFor(() => expect(lastBadge()).toBe(5));

    unmount();
    await waitFor(() => expect(lastBadge()).toBe(0));
  });

  it('아이콘은 서버 배지의 정의를 따른다 — 사이드바가 접는 「여기부터 안 읽음」 마크는 더하지 않는다', async () => {
    // The shared red proof: cursor 10, head 10, mark 3. The server counts 0; the
    // sidebar composes 8 (ADR-0178 D3). The icon must say what the next push
    // will say, or it flips between the two numbers every time one arrives.
    const proof = markAt3Cursor10();
    server.rooms.set(GENERAL, {
      head: proof.latestSeq,
      cursor: proof.lastReadSeq,
      mark: proof.markedUnreadBeforeSeq ?? null,
    });
    room(RANDOM).cursor = room(RANDOM).head;
    expect(serverBadge()).toBe(0);

    await mountShell();
    await waitFor(() =>
      expect(
        screen.getByTestId(`sidebar-row-channel:${GENERAL}`).props.accessibilityLabel,
      ).toBe('채널 general, 안 읽은 메시지 8개'),
    );
    await waitFor(() => expect(badgeWrites().length).toBeGreaterThan(0));
    expect(badgeSequence()).toEqual([0]);
  });
});
