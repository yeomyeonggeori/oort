import type {Member, Message} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {jumpMissedNotice} from '../src/features/conversation/jumpNotice';
import {
  SEEK_MAX_PAGES,
  SEEK_MAX_ROWS,
  SEEK_SETTLE_FREE_ROWS,
  seekSettleMs,
} from '../src/features/conversation/jumpSeek';
import AppShell from '../src/shell/AppShell';
import {sessionPort} from '../src/storage/secureSession';
import {setServerBase} from '../src/storage/serverBase';
import {openPinList} from './fixtures/conversationMenu';
import {installAppClock, SHELL_WAIT_TEST_TIMEOUT_MS} from './fixtures/fakeClock';
import {resetSession} from './testkit';

// =============================================================================
// 불러온 범위 밖(더 오래된 쪽)의 메시지로 가는 점프는 그 자리까지 거슬러 읽는다 (#5383)
//
// 여태 이 점프는 「위쪽에 있습니다」 고지만 세우고 멈췄다(`anchorJump.test.tsx` 의 앞 절반이 그 길을 지금도 잰다 - 읽을 수
// 없는 점프의 길이다). 이제 화면이 `before` 쪽 넘김을 목적지 seq 에 닿을 때까지 이어 읽고, 합친 뒤 같은 문으로 다시 쏜다.
//
// 가짜는 `fetch` 하나뿐이고, 서버처럼 **seq 가 연속인 긴 기록**을 `before=`·`limit=` 대로 내준다 - 쪽을 고정으로 내주는 가짜는
// 몇 쪽을 읽었는지 말하지 못한다. 검색 훅·타임라인 훅·화면은 전부 진짜다.
//
// ## 이 파일의 red proof
//
//   1. **착지** - 쪽을 읽어 닿으면 목록이 그 줄을 들고 점프가 다시 걸리고, 줄이 물든다(`landed`). 읽기를 시작하는 줄을 지우면 첫 단정들이 깨진다.
//   2. **취소** - 접은 뒤에는 늦게 온 답이 합쳐지지도, 점프를 다시 걸지도 않는다. 번호 비교(`seekRunRef`)를 지우면 깨진다.
//   3. **상한** - 쪽 상한에 닿으면 읽기를 멈추고 지금의 고지로 물러난다. 상한 비교를 풀면 깨진다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const GENERAL = 'ch-general';
const BASE = 'https://api.example.com';
const T0 = 1_700_000_000_000;

const HIT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const HIT_SEQ = 42;
/** 첫 페이지의 가장 오래된 seq. 목적지는 이보다 58줄 위다. */
const HEAD_SEQ = 100;

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
  rosterMember({id: OTHER_ID, displayName: '김민수', handle: 'minsu'}),
];

const CHANNELS = [
  {id: GENERAL, workspaceId: WS, kind: 'public', name: 'general', muted: false},
];

function message(seq: number, over: Record<string, unknown> = {}) {
  return {
    id: seq === HIT_SEQ ? HIT_ID : `msg-${seq}`,
    channelId: GENERAL,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: OTHER_ID,
    type: 'text',
    body: seq === HIT_SEQ ? '배포 로그 확인했습니다' : `${seq}번째 메시지`,
    state: 'sent',
    createdAtMs: T0 + seq * 1000,
    ...over,
  };
}

const SEARCH_HIT = {
  channelId: GENERAL,
  messageId: HIT_ID,
  authorMemberId: OTHER_ID,
  seq: HIT_SEQ,
  createdAtMs: T0 + HIT_SEQ * 1000,
  snippet: '배포 로그 확인했습니다',
  matchOffset: 0,
};

/** 로드된 머리에 서 있는 인용. 가리키는 원본(`HIT_ID`)은 아직 안 왔다. */
const QUOTING_MESSAGE = message(HEAD_SEQ + 2, {
  id: 'dddddddd-1111-4111-8111-dddddddddddd',
  body: '그 줄 이야기입니다',
  replyToId: HIT_ID,
  replyTo: {seq: HIT_SEQ},
});

/** 고정 목록 한 건. 가리키는 메시지는 **로드된 페이지에 없다** - 고정은 대개 오래된 줄이다. */
const PINNED_WIRE = {
  messageId: HIT_ID,
  channelId: GENERAL,
  seq: HIT_SEQ,
  authorMemberId: OTHER_ID,
  type: 'text',
  state: 'sent',
  body: '배포 순서는 이 문서가 정본입니다.',
  createdAtMs: T0,
  pinnedBy: SELF_ID,
  pinnedAtMs: T0 + 1_000,
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: {get: () => 'application/json'},
  } as unknown as Response;
}

interface Deferred {
  promise: Promise<void>;
  release: () => void;
}

function deferred(): Deferred {
  let release: () => void = () => undefined;
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return {promise, release};
}

/** `before=` 요청의 기록. 쪽 하나가 한 칸이다. */
interface BeforeCall {
  before: number;
  limit: number | null;
}

interface Server {
  mock: jest.Mock;
  beforeCalls: BeforeCall[];
  /** 서버가 한 쪽에 내주는 줄 수의 상한 - 요청한 `limit` 이 이보다 커도 이만큼만 준다. 없으면 `limit` 대로. */
  pageRows: number | null;
  /** 앞으로 올 `before=` 요청 중 실패시킬 수. */
  failBefore: number;
  /** 서 있으면 `before=` 요청은 이것이 풀릴 때까지 답하지 않는다. */
  hold: Deferred | null;
}

/**
 * seq 가 `firstSeq`(기본 1)부터 이어진 긴 기록을 내주는 서버. 첫 페이지는 `headSeq` 로 시작하는 두 줄이고(+`headExtra`), `before=N` 은
 * seq 가 N 보다 작은 줄을 최근 순으로 `limit`(최대 200) 줄 내준다. 비어 있으면 `nextBefore` 가 없다 - 기록의 처음이다.
 */
function installServer(
  options: {
    headSeq?: number;
    headExtra?: unknown[];
    firstSeq?: number;
    pins?: unknown[];
  } = {},
): Server {
  const firstSeq = options.firstSeq ?? 1;
  const headSeq = options.headSeq ?? HEAD_SEQ;
  const server: Server = {
    mock: jest.fn(),
    beforeCalls: [],
    pageRows: null,
    failBefore: 0,
    hold: null,
  };
  server.mock.mockImplementation(async (url: string) => {
    if (url.includes('/search/messages')) {
      return jsonResponse(200, {hits: [SEARCH_HIT]});
    }
    if (url.includes('/pins')) return jsonResponse(200, {pins: options.pins ?? []});
    if (url.includes('/channels') && !url.includes('/messages')) {
      return jsonResponse(200, {channels: CHANNELS});
    }
    if (url.includes('/roster')) return jsonResponse(200, {members: ROSTER});
    if (url.includes('/read-state')) return jsonResponse(200, {read_states: []});
    if (url.includes('/work-sessions')) {
      return jsonResponse(200, {workSessions: []});
    }
    if (url.includes('/work-hosts')) return jsonResponse(200, {workHosts: []});
    if (url.includes('/messages')) {
      const before = /[?&]before=(\d+)/.exec(url);
      if (before === null) {
        return jsonResponse(200, {
          messages: [
            message(headSeq),
            message(headSeq + 1),
            ...(options.headExtra ?? []),
          ],
          nextBefore: headSeq,
        });
      }
      const cursor = Number(before[1]);
      const asked = /[?&]limit=(\d+)/.exec(url);
      server.beforeCalls.push({
        before: cursor,
        limit: asked === null ? null : Number(asked[1]),
      });
      if (server.hold !== null) await server.hold.promise;
      if (server.failBefore > 0) {
        server.failBefore -= 1;
        return jsonResponse(500, {error: 'unavailable'});
      }
      const rows = Math.min(
        asked === null ? 50 : Number(asked[1]),
        200,
        server.pageRows ?? 200,
      );
      const lowest = Math.max(firstSeq, cursor - rows);
      const page: unknown[] = [];
      for (let seq = cursor - 1; seq >= lowest; seq -= 1) page.push(message(seq));
      return jsonResponse(
        200,
        page.length === 0 ? {messages: []} : {messages: page, nextBefore: lowest},
      );
    }
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/approvals')) return jsonResponse(200, {approvals: []});
    throw new Error(`unrouted request: ${url}`);
  });
  globalThis.fetch = server.mock as unknown as typeof fetch;
  return server;
}

const centrifugeMock = jest.requireMock('centrifuge') as {__reset: () => void};

let queryClient: QueryClient | null = null;

function renderShell() {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {retry: false, gcTime: 0},
      mutations: {retry: false, gcTime: 0},
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AppShell member={SELF} />
    </QueryClientProvider>,
  );
}

type TimelineNode = {props?: Record<string, unknown>};

/** 화면이 `Timeline` 에 건 점프와 목록. `Timeline` 이 받는 프롭을 그대로 읽는다. */
function timelineView(): {
  jumpTarget: {messageId: string; seq: number | null; token: number} | null;
  messages: Message[];
} {
  const nodes = screen.UNSAFE_root.findAll(
    (node: TimelineNode) => node.props?.jumpTarget !== undefined,
  );
  const found = nodes[0]?.props;
  return {
    jumpTarget:
      (found?.jumpTarget as {messageId: string; seq: number | null; token: number}) ??
      null,
    messages: (found?.messages as Message[]) ?? [],
  };
}

const jumpToken = () => timelineView().jumpTarget?.token ?? 0;
const holdsHit = () => timelineView().messages.some(m => m.id === HIT_ID);

/** 목록이 물들인 행들(`landed` 참) - 착지한 줄이 정말 강조됐는가. */
function landedIds(): string[] {
  const ids: string[] = screen.UNSAFE_root
    .findAll(
      (node: TimelineNode) =>
        node.props?.landed === true &&
        typeof (node.props?.message as {id?: unknown})?.id === 'string',
    )
    .map((node: TimelineNode) => (node.props?.message as {id: string}).id);
  return Array.from(new Set<string>(ids));
}

/** 홈 → 검색 탭 → 결과 한 건 누르기. 사람이 실제로 걷는 길 그대로다. */
async function openFromSearch(): Promise<void> {
  renderShell();
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
  fireEvent.press(screen.getByTestId('tab-search'));
  await waitFor(() => expect(screen.getByTestId('search-input')).toBeTruthy());
  fireEvent.changeText(screen.getByTestId('search-input'), '배포 로그');
  await waitFor(() => expect(screen.getByTestId('search-results')).toBeTruthy(), {
    timeout: 5_000,
  });
  fireEvent.press(screen.getAllByTestId('search-result')[0]);
  await waitFor(() =>
    expect(screen.getByTestId('conversation-title')).toBeTruthy(),
  );
}

/** 사이드바 → 채널 한 칸. 앵커 없이 그냥 여는 길. */
async function openConversation(): Promise<void> {
  renderShell();
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
  fireEvent.press(screen.getByTestId(`sidebar-row-channel:${GENERAL}`));
  await waitFor(() =>
    expect(screen.getByTestId('conversation-title')).toBeTruthy(),
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
}

jest.setTimeout(SHELL_WAIT_TEST_TIMEOUT_MS);

beforeEach(() => {
  installAppClock();
  resetSession();
  setServerBase(BASE);
  centrifugeMock.__reset();
  sessionPort.applyLogin(LOGIN_BODY);
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('#5383 — 범위 밖 결과는 그 자리까지 읽어서 착지한다', () => {
  it('RED PROOF — 한 쪽이면 닿는다: 읽고, 합치고, 같은 문으로 다시 쏜다', async () => {
    const server = installServer();
    await openFromSearch();

    // 첫 발은 빈손이었고 화면이 시킨 일을 대신했다 - 고지를 세우지 않는다.
    await waitFor(() => expect(holdsHit()).toBe(true));
    expect(server.beforeCalls).toHaveLength(1);
    // 목적지까지 남은 거리(58)에 맥락(20)을 더한 만큼만 달라고 한다 - 200줄을 받아 오지 않는다.
    expect(server.beforeCalls[0]).toEqual({before: HEAD_SEQ, limit: 78});

    // 두 번째 발. 같은 목적지지만 새 요청이라 토큰이 오른다.
    await waitFor(() => expect(jumpToken()).toBeGreaterThan(1));
    expect(timelineView().jumpTarget?.messageId).toBe(HIT_ID);
    expect(screen.queryByTestId('jump-seek')).toBeNull();
    expect(screen.queryByTestId('jump-missed')).toBeNull();
  });

  it('여러 쪽도 이어 읽는다 - 쪽마다 직전 쪽의 끝에서 이어 받고, 닿으면 줄이 물든다', async () => {
    const server = installServer();
    server.pageRows = 20; // 서버가 한 쪽에 20줄까지만 준다.
    await openFromSearch();

    await waitFor(() => expect(holdsHit()).toBe(true));
    // 100 → 80 → 60 → 40(여기서 42 를 덮는다). 건너뛰거나 겹치지 않는다.
    expect(server.beforeCalls.map(call => call.before)).toEqual([100, 80, 60]);
    // 그리고 그 줄이 정말 강조됐다. 마지막 쪽이 목적지 바로 위에서 끝나 줄이 목록 맨 위 근처(그려지는 창 안)에 선다 -
    // 한 쪽에 닿는 위 시험은 목적지 위에 맥락 20줄이 더 있어 제스트에서는 그 줄이 창 밖이다.
    await waitFor(() => expect(landedIds()).toContain(HIT_ID));
    expect(landedIds()).toEqual([HIT_ID]);
  });

  it('인용도 같은 문을 탄다 - 인용한 원본이 범위 밖이면 읽어서 착지한다', async () => {
    const server = installServer({headExtra: [QUOTING_MESSAGE]});
    await openConversation();

    await waitFor(() => expect(screen.getByTestId('quote-block')).toBeTruthy());
    expect(server.beforeCalls).toHaveLength(0);
    fireEvent.press(screen.getByTestId('quote-block'));

    await waitFor(() => expect(holdsHit()).toBe(true));
    await waitFor(() => expect(jumpToken()).toBeGreaterThan(1));
    expect(timelineView().jumpTarget?.messageId).toBe(HIT_ID);
    expect(screen.queryByTestId('jump-missed')).toBeNull();
    expect(server.beforeCalls).toHaveLength(1);
  });
});

describe('#5383 — 많이 합친 점프는 목록이 앉을 시간을 준다', () => {
  // 시뮬레이터 실측(`jumpSeek.ts` 머리말): 1,800줄을 합친 같은 커밋에서 점프를 걸면 목적지에서 1,500줄 넘게 떨어진 곳에서 멈췄다.
  const FAR_HEAD = 1100; // 목적지(42)는 1,058줄 위 → 6쪽, 합친 줄 > 300

  it(`${SEEK_SETTLE_FREE_ROWS}줄을 넘게 합치면 합친 직후가 아니라 기다린 뒤에 다시 쏘고, 그동안 읽는 줄이 선다`, async () => {
    const server = installServer({headSeq: FAR_HEAD});
    await openFromSearch();

    await waitFor(() => expect(holdsHit()).toBe(true));
    expect(server.beforeCalls).toHaveLength(6);
    expect(seekSettleMs(FAR_HEAD - HIT_SEQ)).toBeGreaterThan(0);
    // 합쳐졌지만 점프는 아직이다 - 토큰이 그대로이고 읽는 줄(과 취소)이 서 있다.
    const tokenAtMerge = jumpToken();
    expect(screen.getByTestId('jump-seek-cancel')).toBeTruthy();

    // 기다림이 끝나면 같은 문으로 다시 쏘고 줄이 걷힌다.
    await waitFor(() => expect(jumpToken()).toBeGreaterThan(tokenAtMerge));
    expect(timelineView().jumpTarget?.messageId).toBe(HIT_ID);
    expect(screen.queryByTestId('jump-seek')).toBeNull();
    expect(screen.queryByTestId('jump-missed')).toBeNull();
  });

  it('기다리는 동안 취소하면 점프를 다시 걸지 않는다', async () => {
    installServer({headSeq: FAR_HEAD});
    await openFromSearch();

    await waitFor(() => expect(holdsHit()).toBe(true));
    const tokenAtMerge = jumpToken();
    fireEvent.press(screen.getByTestId('jump-seek-cancel'));
    expect(screen.queryByTestId('jump-seek')).toBeNull();

    // 기다림이 다 지나도 데려가지 않는다 - 합친 줄은 남아 있고 목록은 읽던 자리 그대로다.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2_000);
    });
    expect(jumpToken()).toBe(tokenAtMerge);
    expect(screen.queryByTestId('jump-missed')).toBeNull();
  });
});

describe('#5383 — 다른 입구도 같은 문이다', () => {
  it('고정 목록 - 고정한 메시지가 범위 밖이면 읽어서 착지한다', async () => {
    const server = installServer({pins: [PINNED_WIRE]});
    await openConversation();

    await openPinList();
    await waitFor(() => expect(screen.getByTestId('pin-list')).toBeTruthy());
    fireEvent.press(screen.getAllByTestId('pin-list-item')[0]);

    await waitFor(() => expect(holdsHit()).toBe(true));
    await waitFor(() => expect(jumpToken()).toBeGreaterThan(1));
    expect(timelineView().jumpTarget?.messageId).toBe(HIT_ID);
    expect(screen.queryByTestId('jump-missed')).toBeNull();
    expect(server.beforeCalls).toHaveLength(1);
  });
});

describe('#5383 — 읽는 동안: 찾는 중과 취소', () => {
  it('읽는 줄이 서고, 취소하면 늦게 온 답이 합쳐지지도 점프를 다시 걸지도 않는다', async () => {
    const server = installServer();
    server.hold = deferred();
    await openFromSearch();

    // 답이 오지 않는 동안 입력창 위 한 줄이 「찾는 중」을 말하고 취소가 있다.
    await waitFor(() => expect(screen.getByTestId('jump-seek')).toBeTruthy());
    expect(screen.getByTestId('jump-seek-text')).toHaveTextContent(
      '이전 대화에서 메시지를 찾는 중이에요',
    );
    expect(screen.queryByTestId('jump-seek-retry')).toBeNull();
    const tokenWhileReading = jumpToken();

    fireEvent.press(screen.getByTestId('jump-seek-cancel'));
    expect(screen.queryByTestId('jump-seek')).toBeNull();

    // 이미 나간 요청의 답이 이제 온다.
    await act(async () => {
      server.hold?.release();
      await jest.advanceTimersByTimeAsync(0);
    });
    await flush();

    expect(holdsHit()).toBe(false);
    expect(jumpToken()).toBe(tokenWhileReading);
    expect(screen.queryByTestId('jump-seek')).toBeNull();
    expect(screen.queryByTestId('jump-missed')).toBeNull();
    // 접은 뒤에는 더 읽지 않는다.
    expect(server.beforeCalls).toHaveLength(1);
  });
});

describe('#5383 — 실패하면 다시 시도할 수 있다', () => {
  it('실패한 읽기는 아무것도 합치지 않고 다시 시도가 서며, 다시 하면 착지한다', async () => {
    const server = installServer();
    server.failBefore = 1;
    await openFromSearch();

    await waitFor(() => expect(screen.getByTestId('jump-seek-retry')).toBeTruthy());
    expect(screen.getByTestId('jump-seek-text')).toHaveTextContent(
      '이전 대화를 불러오지 못했어요',
    );
    // 읽는 중의 취소는 없고, 닫기가 있다. 화면은 읽기 전 그대로다.
    expect(screen.queryByTestId('jump-seek-cancel')).toBeNull();
    expect(screen.getByTestId('jump-seek-dismiss')).toBeTruthy();
    expect(holdsHit()).toBe(false);
    const failedToken = jumpToken();

    fireEvent.press(screen.getByTestId('jump-seek-retry'));

    await waitFor(() => expect(holdsHit()).toBe(true));
    await waitFor(() => expect(jumpToken()).toBeGreaterThan(failedToken));
    expect(screen.queryByTestId('jump-seek')).toBeNull();
    // 실패한 요청과 다시 시도한 요청 - 둘 다 같은 끝에서 이어 받는다.
    expect(server.beforeCalls.map(call => call.before)).toEqual([HEAD_SEQ, HEAD_SEQ]);
  });

  it('닫으면 줄이 걷히고 더 읽지 않는다', async () => {
    const server = installServer();
    server.failBefore = 1;
    await openFromSearch();

    await waitFor(() => expect(screen.getByTestId('jump-seek-retry')).toBeTruthy());
    fireEvent.press(screen.getByTestId('jump-seek-dismiss'));
    expect(screen.queryByTestId('jump-seek')).toBeNull();
    await flush();
    expect(server.beforeCalls).toHaveLength(1);
    expect(holdsHit()).toBe(false);
  });
});

describe('#5383 — 상한: 넘으면 지금의 고지로 물러난다', () => {
  it(`쪽 상한(${SEEK_MAX_PAGES}쪽)에 닿으면 읽기를 멈추고 아무것도 합치지 않은 채 고지가 선다`, async () => {
    const server = installServer();
    // 서버가 5줄씩만 준다: 목적지는 58줄 위라 12쪽이 필요하고, 상한은 10쪽이다.
    server.pageRows = 5;
    await openFromSearch();

    await waitFor(() => expect(screen.getByTestId('jump-missed')).toBeTruthy());
    expect(server.beforeCalls).toHaveLength(SEEK_MAX_PAGES);
    // 지금의 고지 그대로다 - 찾던 메시지는 더 위쪽에 있다고 사실을 말한다.
    expect(screen.getByTestId('jump-missed')).toHaveTextContent(
      new RegExp(jumpMissedNotice('older', 'search').headline),
    );
    expect(screen.queryByTestId('jump-seek')).toBeNull();
    // 닿지 못한 읽기는 합치지 않는다 - 화면은 읽기 전 그대로다.
    expect(holdsHit()).toBe(false);
    expect(timelineView().messages).toHaveLength(2);
  });

  it(`거리가 ${SEEK_MAX_ROWS}줄을 넘으면 한 건도 읽지 않고 곧장 고지로 간다`, async () => {
    // 첫 페이지의 가장 오래된 seq 가 5000 이라 목적지(42)는 4958줄 위다.
    const server = installServer({headSeq: 5000});
    await openFromSearch();

    await waitFor(() => expect(screen.getByTestId('jump-missed')).toBeTruthy());
    expect(server.beforeCalls).toHaveLength(0);
    expect(screen.getByTestId('jump-missed')).toHaveTextContent(
      new RegExp(jumpMissedNotice('older', 'search').headline),
    );
    expect(screen.queryByTestId('jump-seek')).toBeNull();
  });

  it('채널의 처음까지 읽었는데 없으면 「더 위쪽」이 아니라 「찾지 못했습니다」라고 말한다', async () => {
    // 첫 페이지가 seq 60 부터이고 기록은 50 에서 시작한다(앞 줄이 지워진 채널). 목적지(42)는 위에 있지만 어디에도 없다.
    const server = installServer({headSeq: 60, firstSeq: 50});
    await openFromSearch();

    await waitFor(() => expect(screen.getByTestId('jump-missed')).toBeTruthy());
    // 50 에서 한 번 더 읽어 기록의 처음임을 알았다.
    expect(server.beforeCalls.map(call => call.before)).toEqual([60, 50]);
    expect(screen.getByTestId('jump-missed')).toHaveTextContent(
      new RegExp(jumpMissedNotice('unknown', 'search').headline),
    );
    expect(screen.getByTestId('jump-missed')).not.toHaveTextContent(/더 위쪽/);
  });
});
