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
import {makeDirectory} from '@momo/core/features/workspace/directory';
import React from 'react';
import {StyleSheet} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {FixedScheme} from '../src/design/theme';
import {ConversationSearchPanel} from '../src/features/conversation/ConversationSearchPanel';
import {ConversationSearchRow} from '../src/features/conversation/ConversationSearchRow';
import type {ConversationSearch} from '../src/features/conversation/useConversationSearch';
import {readRecent, rememberRecent} from '../src/features/conversation/conversationSearchRecent';
import {SessionProvider, useSession} from '../src/session/useSession';
import AppShell from '../src/shell/AppShell';
import {sessionPort} from '../src/storage/secureSession';
import {setServerBase} from '../src/storage/serverBase';
import {installAppClock, SHELL_WAIT_TEST_TIMEOUT_MS} from './fixtures/fakeClock';
import {mmkvStore, resetSession} from './testkit';

// =============================================================================
// 폰 대화 안 검색 (#5364) — 머리 돋보기 → 검색 줄 → 결과 목록 → 그 메시지로 이동 → 위·아래 → 「목록」 복귀.
//
// 가짜는 `fetch` 하나뿐이다. 검색 훅·타임라인 훅·화면·셸은 전부 진짜라서 단정은 「호출했는가」가 아니라 **화면이 받은 것**이다:
// 서버로 나간 주소(`channel=` 이 실렸는가), 타임라인이 받은 점프(`jumpTarget`), 막대에 적힌 번호(`3 / 3+`).
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const GENERAL = 'ch-general';
const BASE = 'https://api.example.com';
const T0 = 1_700_000_000_000;

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

const CHANNELS = [{id: GENERAL, workspaceId: WS, kind: 'public', name: 'general', muted: false}];

function message(seq: number, over: Record<string, unknown> = {}) {
  return {
    id: `msg-${seq}`,
    channelId: GENERAL,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: OTHER_ID,
    type: 'text',
    body: `${seq}번째 메시지`,
    state: 'sent',
    createdAtMs: T0 + seq * 1000,
    ...over,
  };
}

// 타임라인이 불러 둔 창 — 결과 셋이 전부 이 안에 있어서 점프가 실제로 착지한다(못 찾았다는 고지가 서지 않는다).
const LOADED = [message(100), message(101), message(102), message(103)];

function hit(seq: number, author: string) {
  return {
    channelId: GENERAL,
    messageId: `msg-${seq}`,
    authorMemberId: author,
    seq,
    createdAtMs: T0 + seq * 1000,
    snippet: `${seq}번 배포 일정 확인`,
    // 「배포」는 `N번 ` 뒤에서 시작한다(세 자리 + 「번」 + 공백).
    matchOffset: 5,
  };
}

// 서버는 최근 순으로 준다: 103(남) → 102(나) 가 첫 쪽이고 커서가 남는다. 둘째 쪽은 101 하나이고 커서 키가 **아예 없다**.
const HIT_103 = hit(103, OTHER_ID);
const HIT_102 = hit(102, SELF_ID);
const HIT_101 = hit(101, OTHER_ID);
// 타임라인이 불러 둔 창(100~103)보다 **오래된** 결과 — 이동 문이 「위쪽에 있다」고 말하는 경우다.
const HIT_OLD = hit(40, OTHER_ID);

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: {get: () => 'application/json'},
  } as unknown as Response;
}

/** 가짜 서버가 `before=` 요청을 붙들어 둘 때의 열쇠(#5383 읽는 동안 줄을 보려고). */
interface Hold {
  promise: Promise<void>;
  release: () => void;
}

function hold(): Hold {
  let release: () => void = () => undefined;
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return {promise, release};
}

function installFetch(
  options: {
    searchStatus?: number;
    firstPage?: unknown[];
    hasSecondPage?: boolean;
    /**
     * #5383: 첫 페이지 뒤에 **더 오래된 줄이 있는** 방(서버는 그럴 때 첫 페이지에 `nextBefore` 를 싣는다). 기본은 없는 방이라 타임라인이 「처음까지 읽었다」로
     * 알고, 그 방에서는 이동 문이 위로 읽지 않는다 - 위로 읽는 시험만 켠다.
     */
    olderExists?: boolean;
    /** 불러온 범위 위(`before=`)를 읽는 요청. 한 쪽에 내주는 줄 수의 상한(없으면 요청한 `limit` 대로)과, 답을 붙들어 둘 열쇠. */
    olderPageRows?: number;
    olderHold?: Hold;
  } = {},
) {
  const mock = jest.fn(async (url: string) => {
    if (url.includes('/search/messages')) {
      if (options.searchStatus !== undefined && options.searchStatus >= 400) {
        return jsonResponse(options.searchStatus, {error: 'boom'});
      }
      if (url.includes('cursor=')) return jsonResponse(200, {hits: [HIT_101]});
      const hasSecondPage = options.hasSecondPage ?? true;
      return jsonResponse(200, {
        hits: options.firstPage ?? [HIT_103, HIT_102],
        ...(hasSecondPage ? {nextCursor: 'cursor-2'} : {}),
      });
    }
    if (url.includes('/pins')) return jsonResponse(200, {pins: []});
    if (url.includes('/channels') && !url.includes('/messages')) {
      return jsonResponse(200, {channels: CHANNELS});
    }
    if (url.includes('/roster')) return jsonResponse(200, {members: ROSTER});
    if (url.includes('/read-state')) return jsonResponse(200, {read_states: []});
    if (url.includes('/work-sessions')) return jsonResponse(200, {workSessions: []});
    if (url.includes('/work-hosts')) return jsonResponse(200, {workHosts: []});
    if (url.includes('/messages')) {
      const before = /[?&]before=(\d+)/.exec(url);
      if (before === null) {
        return jsonResponse(200, options.olderExists === true ? {messages: LOADED, nextBefore: 100} : {messages: LOADED});
      }
      // 위로 읽기: seq 가 `before` 보다 작은 줄을 최근 순으로(서버처럼 연속·빠짐없이) 내준다. 비면 `nextBefore` 가 없다.
      if (options.olderHold !== undefined) await options.olderHold.promise;
      const asked = /[?&]limit=(\d+)/.exec(url);
      const rows = Math.min(asked === null ? 50 : Number(asked[1]), 200, options.olderPageRows ?? 200);
      const cursor = Number(before[1]);
      const lowest = Math.max(1, cursor - rows);
      const page = [];
      for (let seq = cursor - 1; seq >= lowest; seq -= 1) page.push(message(seq));
      return jsonResponse(200, page.length === 0 ? {messages: []} : {messages: page, nextBefore: lowest});
    }
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/approvals')) return jsonResponse(200, {approvals: []});
    throw new Error(`unrouted request: ${url}`);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
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

/** 화면이 목록에 건 점프. `Timeline` 이 받는 프롭을 그대로 읽는다. */
function jumpTargetOf(): {messageId: string; seq: number | null; token: number} | null {
  const nodes = screen.UNSAFE_root.findAll(
    (node: {props?: Record<string, unknown>}) => node.props?.jumpTarget !== undefined,
  );
  const found = nodes[0]?.props?.jumpTarget;
  return (found as {messageId: string; seq: number | null; token: number}) ?? null;
}

async function openConversation(): Promise<void> {
  renderShell();
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
  fireEvent.press(screen.getByTestId(`sidebar-row-channel:${GENERAL}`));
  await waitFor(() => expect(screen.getByTestId('conversation-title')).toBeTruthy());
  // 채널 종류를 알아야 돋보기가 선다(채널 목록이 온 뒤).
  await waitFor(() => expect(screen.getByTestId('conversation-search')).toBeTruthy());
}

async function openSearch(): Promise<void> {
  await openConversation();
  fireEvent.press(screen.getByTestId('conversation-search'));
  await waitFor(() => expect(screen.getByTestId('conversation-search-row')).toBeTruthy());
}

async function typeQuery(text: string): Promise<void> {
  fireEvent.changeText(screen.getByTestId('conversation-search-input'), text);
  await waitFor(() => expect(screen.getByTestId('conversation-search-results')).toBeTruthy(), {timeout: 5_000});
}

async function search(text = '배포'): Promise<void> {
  await openSearch();
  await typeQuery(text);
}

const positionText = () => screen.getByTestId('conversation-search-position-text').props.children as string;

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

describe('#5364 대화 안 검색 — 진입', () => {
  it('머리의 ⋮ 옆 돋보기를 누르면 머리 줄이 검색 줄로 바뀌고 컴포저가 숨으며, X 로 끝내면 모두 돌아온다', async () => {
    installFetch();
    await openConversation();

    // 돋보기는 ⋮ 와 같은 오른쪽 칸에 있고, 더보기 시트의 항목이 아니다.
    const end = screen.getByTestId('conversation-header-end');
    expect(within(end).getByTestId('conversation-search')).toBeTruthy();
    expect(within(end).getByTestId('conversation-menu')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('conversation-composer-stack').props.style)?.display).not.toBe('none');

    fireEvent.press(screen.getByTestId('conversation-search'));
    await waitFor(() => expect(screen.getByTestId('conversation-search-row')).toBeTruthy());

    // 뒤로·이름 알약·⋮ 가 있던 줄이 통째로 바뀌었다.
    expect(screen.queryByTestId('conversation-header-row')).toBeNull();
    expect(screen.queryByTestId('conversation-menu')).toBeNull();
    // 안내문이 범위를 말한다(채널).
    expect(screen.getByTestId('conversation-search-input').props.placeholder).toBe('이 채널에서 찾기');
    // 컴포저 묶음은 걷히지 않고 숨는다 — 마운트가 유지돼야 쓰던 것이 남는다.
    // (`display: 'none'` 인 노드는 조회의 기본값에서 빠진다 — 그래서 「안 보이는 채로 마운트돼 있다」를 둘로 단정한다.)
    expect(screen.queryByTestId('conversation-composer-stack')).toBeNull();
    const hidden = screen.getByTestId('conversation-composer-stack', {includeHiddenElements: true});
    expect(StyleSheet.flatten(hidden.props.style)?.display).toBe('none');
    // 결과 목록 면이 덮는 동안 대화(목록·컴포저)는 화면 낭독에서 빠진다 — 보이지 않는 행에 초점이 닿지 않게.
    expect(screen.getByTestId('conversation-layout-wrap', {includeHiddenElements: true}).props.accessibilityElementsHidden).toBe(true);
    // 입력 전: 최근 검색이 없으면 한 줄 안내가 서고, 아직 아무 검색도 나가지 않았다.
    expect(screen.getByTestId('conversation-search-idle-hint')).toBeTruthy();
    expect(screen.queryByTestId('conversation-search-results')).toBeNull();

    fireEvent.press(screen.getByTestId('conversation-search-close'));
    await waitFor(() => expect(screen.getByTestId('conversation-menu')).toBeTruthy());
    expect(screen.queryByTestId('conversation-search-row')).toBeNull();
    expect(screen.queryByTestId('conversation-search-panel')).toBeNull();
    expect(StyleSheet.flatten(screen.getByTestId('conversation-composer-stack').props.style)?.display).not.toBe('none');
  });
});

describe('#5364 대화 안 검색 — 찾기', () => {
  it('이 대화 하나로 좁혀 찾고(channel=), 최근 순 결과에 보낸 사람(내 글은 「나」)과 찾은 글자 강조가 선다', async () => {
    const fetchMock = installFetch();
    await search('배포');

    const searchCalls = fetchMock.mock.calls.map(call => call[0] as string).filter(url => url.includes('/search/messages'));
    expect(searchCalls).toHaveLength(1);
    // 범위가 서버로 간다 — 이 조각이 빠지면 워크스페이스 전체를 찾는다.
    expect(searchCalls[0]).toContain(`channel=${GENERAL}`);
    expect(searchCalls[0]).toContain(`q=${encodeURIComponent('배포')}`);

    const rows = screen.getAllByTestId('conversation-search-result');
    expect(rows).toHaveLength(2);
    // 최근 순: 103(김민수) 다음 102(나).
    expect(within(rows[0]).getByText('김민수')).toBeTruthy();
    expect(within(rows[1]).getByText('나')).toBeTruthy();
    // 서버가 준 위치에서 찾은 글자만 강조된다.
    expect(within(rows[0]).getByTestId('conversation-search-match').props.children).toBe('배포');
    expect(screen.getByTestId('conversation-search-results-head').props.children).toBe('이 채널의 결과 · 최근 순');
  });

  it('상태 셋: 두 글자 미만은 안내(요청 없음), 결과 없음은 말을 인용해 알리고, 오류는 다시 시도를 준다', async () => {
    const fetchMock = installFetch({firstPage: []});
    await openSearch();
    fireEvent.changeText(screen.getByTestId('conversation-search-input'), '배');
    await waitFor(() => expect(screen.getByTestId('conversation-search-too-short')).toBeTruthy());
    expect(fetchMock.mock.calls.some(call => (call[0] as string).includes('/search/messages'))).toBe(false);

    fireEvent.changeText(screen.getByTestId('conversation-search-input'), '배포');
    await waitFor(() => expect(screen.getByTestId('conversation-search-empty')).toBeTruthy(), {timeout: 5_000});
    expect(screen.getByText('‘배포’ 검색 결과가 없어요.')).toBeTruthy();
  });

  it('검색이 실패하면 오류와 다시 시도가 서고, 다시 시도하면 결과가 선다', async () => {
    const fetchMock = installFetch({searchStatus: 500});
    await openSearch();
    fireEvent.changeText(screen.getByTestId('conversation-search-input'), '배포');
    await waitFor(() => expect(screen.getByTestId('conversation-search-error')).toBeTruthy(), {timeout: 5_000});

    // 서버가 살아났다.
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/search/messages')
        ? jsonResponse(200, {hits: [HIT_103]})
        : jsonResponse(200, {messages: LOADED, channels: CHANNELS, members: ROSTER, pins: [], read_states: []}),
    );
    fireEvent.press(within(screen.getByTestId('conversation-search-error')).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('conversation-search-results')).toBeTruthy(), {timeout: 5_000});
  });
});

describe('#5364 대화 안 검색 — 이동', () => {
  it('결과를 누르면 그 메시지로 점프가 걸리고 컴포저 자리에 「1 / 2+」 막대가 선다', async () => {
    installFetch();
    await search();

    fireEvent.press(screen.getAllByTestId('conversation-search-result')[0]);

    await waitFor(() => expect(jumpTargetOf()?.messageId).toBe('msg-103'));
    expect(jumpTargetOf()?.seq).toBe(103);
    // 목록 면은 물러나고 대화가 보인다. 막대는 최근 결과가 1번이고, 다음 쪽이 남았으니 총 건수에 +가 붙는다.
    expect(screen.queryByTestId('conversation-search-panel')).toBeNull();
    // 대화가 다시 보이니 낭독에도 돌아온다.
    expect(screen.getByTestId('conversation-layout-wrap').props.accessibilityElementsHidden).toBe(false);
    expect(positionText()).toBe('1 / 2+');
    // 가장 최근 결과라 ↓ 는 꺼져 있다.
    expect(screen.getByTestId('conversation-search-newer').props.accessibilityState.disabled).toBe(true);
  });

  it('↑ 는 더 오래된 결과, ↓ 는 더 최근 결과로 가고, 불러온 끝의 ↑ 는 다음 쪽을 불러와 이어 가며 다 불러오면 +가 떨어진다', async () => {
    const fetchMock = installFetch();
    await search();
    fireEvent.press(screen.getAllByTestId('conversation-search-result')[0]);
    await waitFor(() => expect(jumpTargetOf()?.messageId).toBe('msg-103'));

    fireEvent.press(screen.getByTestId('conversation-search-older'));
    await waitFor(() => expect(jumpTargetOf()?.messageId).toBe('msg-102'));
    expect(positionText()).toBe('2 / 2+');

    // 불러온 끝(2번)에서 ↑ — 다음 쪽(cursor)을 불러온 뒤 그 결과로 간다.
    fireEvent.press(screen.getByTestId('conversation-search-older'));
    await waitFor(() => expect(jumpTargetOf()?.messageId).toBe('msg-101'));
    expect(
      fetchMock.mock.calls.some(call => (call[0] as string).includes('/search/messages') && (call[0] as string).includes('cursor=cursor-2')),
    ).toBe(true);
    // 다 불러왔다: 정확한 수이고 +가 없다. 가장 오래된 결과라 ↑ 가 꺼진다.
    expect(positionText()).toBe('3 / 3');
    expect(screen.getByTestId('conversation-search-older').props.accessibilityState.disabled).toBe(true);

    fireEvent.press(screen.getByTestId('conversation-search-newer'));
    await waitFor(() => expect(jumpTargetOf()?.messageId).toBe('msg-102'));
    expect(positionText()).toBe('2 / 3');
  });

  it('이미 불러온 범위 밖의 오래된 결과가 읽어도 닿지 못하면(쪽 상한) 이동 문의 고지가 막대 위에 서고(목록 맨 위에 묻히지 않는다), 검색을 끝내도 같은 자리(입력창 위)에 선다', async () => {
    // #5383: 범위 밖 결과는 이제 화면이 그 자리까지 읽는다. 서버가 한 쪽에 5줄만 주면 60줄 위의 결과(40)는 2쪽(상한)에 못 닿아 지금의 고지로 물러난다.
    installFetch({firstPage: [HIT_OLD], hasSecondPage: false, olderExists: true, olderPageRows: 5});
    await search();
    fireEvent.press(screen.getAllByTestId('conversation-search-result')[0]);

    await waitFor(() => expect(jumpTargetOf()?.messageId).toBe('msg-40'));
    // 같은 상자 하나뿐이고, 사람이 있는 아래쪽(컴포저 도크)에 막대와 함께 선다.
    await waitFor(() => expect(screen.getAllByTestId('jump-missed')).toHaveLength(1));
    const dock = screen.getByTestId('composer-dock');
    expect(within(dock).getByTestId('jump-missed')).toBeTruthy();
    expect(within(dock).getByTestId('conversation-search-bar')).toBeTruthy();
    // 총 건수는 다 불러온 수다(+ 없음).
    expect(positionText()).toBe('1 / 1');

    fireEvent.press(screen.getByTestId('conversation-search-close'));
    await waitFor(() => expect(screen.getByTestId('conversation-menu')).toBeTruthy());
    // #5384: 고지는 검색이 끝나도 목록 맨 위로 돌아가지 않는다 - 입력창 바로 위, 같은 자리에 한 벌만 선다(바닥에 있는 사람에게 보이는 자리).
    expect(screen.getAllByTestId('jump-missed')).toHaveLength(1);
    expect(within(screen.getByTestId('composer-dock')).getByTestId('jump-missed')).toBeTruthy();
    expect(within(screen.getByTestId('conversation-list')).queryByTestId('jump-missed')).toBeNull();
  });

  it('#5383 범위 밖 결과를 누르면 읽는 줄이 막대 위(숨은 컴포저 밖)에 서고, 읽고 나면 그 메시지로 점프가 다시 걸리며 줄이 걷힌다', async () => {
    const gate = hold();
    installFetch({firstPage: [HIT_OLD], hasSecondPage: false, olderExists: true, olderHold: gate});
    await search();
    fireEvent.press(screen.getAllByTestId('conversation-search-result')[0]);

    // 읽는 동안: 검색 중이라 컴포저 묶음은 숨어 있지만 읽는 줄은 그 밖(도크 위)에 보인다. 고지는 아직 없다.
    await waitFor(() => expect(screen.getByTestId('jump-seek')).toBeTruthy());
    expect(within(screen.getByTestId('composer-dock')).getByTestId('jump-seek-cancel')).toBeTruthy();
    // 숨은 틀은 기본 조회에서 빠진다(`display: none`) - 숨겨졌다는 사실 자체를 재려고 숨은 것도 보는 조회를 쓴다.
    expect(
      StyleSheet.flatten(
        screen.getByTestId('conversation-composer-stack', {includeHiddenElements: true}).props.style,
      )?.display,
    ).toBe('none');
    expect(screen.queryByTestId('jump-missed')).toBeNull();
    expect(positionText()).toBe('1 / 1');
    const tokenWhileReading = jumpTargetOf()?.token ?? 0;

    await act(async () => {
      gate.release();
      await jest.advanceTimersByTimeAsync(0);
    });

    // 닿았다: 같은 문으로 다시 쏘고(토큰이 오른다) 줄이 걷히며 고지는 서지 않는다.
    await waitFor(() => expect(jumpTargetOf()?.token ?? 0).toBeGreaterThan(tokenWhileReading));
    expect(jumpTargetOf()?.messageId).toBe('msg-40');
    expect(screen.queryByTestId('jump-seek')).toBeNull();
    expect(screen.queryByTestId('jump-missed')).toBeNull();
    // 막대는 그대로 선다.
    expect(screen.getByTestId('conversation-search-bar')).toBeTruthy();
  });

  it('#5383 ↑ 로 범위 밖의 더 오래된 결과로 가면 읽어서 착지한다', async () => {
    const fetchMock = installFetch({firstPage: [HIT_103, HIT_OLD], hasSecondPage: false, olderExists: true});
    await search();
    fireEvent.press(screen.getAllByTestId('conversation-search-result')[0]);
    await waitFor(() => expect(jumpTargetOf()?.messageId).toBe('msg-103'));
    // 첫 결과는 불러온 범위 안이라 읽지 않았다.
    const olderReads = () =>
      fetchMock.mock.calls.filter(call => /[?&]before=/.test(call[0] as string)).length;
    expect(olderReads()).toBe(0);
    const tokenBeforeUp = jumpTargetOf()?.token ?? 0;

    fireEvent.press(screen.getByTestId('conversation-search-older'));

    await waitFor(() => expect(jumpTargetOf()?.messageId).toBe('msg-40'));
    // 읽고 난 뒤 같은 문으로 한 번 더 쐈다(처음 쏜 한 발 + 두 번째 발).
    await waitFor(() => expect(jumpTargetOf()?.token ?? 0).toBeGreaterThan(tokenBeforeUp + 1));
    expect(olderReads()).toBeGreaterThan(0);
    expect(positionText()).toBe('2 / 2');
    expect(screen.queryByTestId('jump-seek')).toBeNull();
    expect(screen.queryByTestId('jump-missed')).toBeNull();
  });

  it('「목록」은 결과 목록으로 돌아가고, 같은 목록에서 다른 결과를 고를 수 있으며, 이동한 뒤 인용을 걸면(글쓰기 시작) 검색이 끝나고 컴포저가 돌아온다', async () => {
    installFetch();
    await search();
    fireEvent.press(screen.getAllByTestId('conversation-search-result')[0]);
    await waitFor(() => expect(screen.getByTestId('conversation-search-bar')).toBeTruthy());

    fireEvent.press(screen.getByTestId('conversation-search-list'));
    await waitFor(() => expect(screen.getByTestId('conversation-search-results')).toBeTruthy());
    expect(screen.queryByTestId('conversation-search-bar')).toBeNull();
    expect(screen.getAllByTestId('conversation-search-result')).toHaveLength(2);

    fireEvent.press(screen.getAllByTestId('conversation-search-result')[1]);
    await waitFor(() => expect(jumpTargetOf()?.messageId).toBe('msg-102'));
    expect(positionText()).toBe('2 / 2+');

    // 이동한 뒤 대화는 손으로 만질 수 있다. 메시지를 길게 눌러 「인용」을 걸면 글쓰기가 시작된 것이다 — 컴포저가 숨은 채로 자판만 뜨지 않도록 검색이 끝난다.
    const point = {nativeEvent: {pageX: 100, pageY: 200, locationX: 100, locationY: 200}};
    fireEvent(screen.getAllByTestId('message-row')[0], 'touchStart', point);
    fireEvent(screen.getAllByTestId('message-press')[0], 'longPress');
    await waitFor(() => expect(screen.getByTestId('message-action-sheet')).toBeTruthy());
    fireEvent.press(screen.getByTestId('sheet-quote'));
    await waitFor(() => expect(screen.queryByTestId('conversation-search-row')).toBeNull());
    expect(screen.queryByTestId('conversation-search-bar')).toBeNull();
    expect(StyleSheet.flatten(screen.getByTestId('conversation-composer-stack').props.style)?.display).not.toBe('none');
  });
});

describe('#5384 대화 안 검색 — 「모든 대화에서 ›」', () => {
  it('결과 머리의 「모든 대화에서 ›」가 같은 말로 홈 검색 탭을 연다 - 대화는 걷히고 검색칸에 말이 들어 있으며, 이번 요청에는 channel= 이 없다', async () => {
    const fetchMock = installFetch();
    await search('배포');
    const searchCalls = () =>
      fetchMock.mock.calls.map(call => call[0] as string).filter(url => url.includes('/search/messages'));
    // 이 대화 안의 검색이 먼저 나갔다(범위가 있다).
    expect(searchCalls()).toHaveLength(1);
    expect(searchCalls()[0]).toContain(`channel=${GENERAL}`);

    // 결과 머리의 오른쪽 문. 눌림 이름이 어떤 말로 넘어가는지도 말한다.
    const door = screen.getByTestId('conversation-search-all');
    expect(door).toHaveTextContent('모든 대화에서');
    expect(door.props.accessibilityLabel).toBe('모든 대화에서 ‘배포’ 찾기');
    fireEvent.press(door);

    // 셸이 탭을 검색으로 옮겼다: 이 대화는 걷히고, 검색칸에 같은 말이 들어 있다(다시 치지 않는다).
    await waitFor(() => expect(screen.getByTestId('search-input')).toBeTruthy());
    expect(screen.queryByTestId('conversation-title')).toBeNull();
    expect(screen.getByTestId('search-input').props.value).toBe('배포');
    // 이미 다 친 말이라 디바운스를 기다리지 않고 이 대화 밖까지 찾는다 - 범위(`channel=`)가 빠진 요청이다.
    await waitFor(() => expect(searchCalls()).toHaveLength(2), {timeout: 5_000});
    expect(searchCalls()[1]).not.toContain('channel=');
    expect(searchCalls()[1]).toContain(`q=${encodeURIComponent('배포')}`);
    await waitFor(() => expect(screen.getByTestId('search-results')).toBeTruthy(), {timeout: 5_000});
  });

  it('입력칸의 말을 다듬어(앞뒤 공백 없이) 넘긴다', async () => {
    installFetch();
    await openSearch();
    await typeQuery('  배포  ');
    fireEvent.press(screen.getByTestId('conversation-search-all'));
    await waitFor(() => expect(screen.getByTestId('search-input')).toBeTruthy());
    expect(screen.getByTestId('search-input').props.value).toBe('배포');
  });
});

describe('#5364 대화 안 검색 — 최근 검색(이 폰에만)', () => {
  it('결과를 고르면 그 말이 이 대화의 최근 검색에 남고, 다시 열면 한 줄로 서며 누르면 바로 찾고, 「지우기」가 모두 지운다', async () => {
    const fetchMock = installFetch();
    await search();
    fireEvent.press(screen.getAllByTestId('conversation-search-result')[0]);
    await waitFor(() => expect(readRecent(WS, GENERAL)).toEqual(['배포']));
    // 서버로는 가지 않는다 — 기기 저장소에만 있다.
    expect(fetchMock.mock.calls.every(call => !(call[0] as string).includes('recent'))).toBe(true);

    fireEvent.press(screen.getByTestId('conversation-search-close'));
    await waitFor(() => expect(screen.getByTestId('conversation-search')).toBeTruthy());
    fireEvent.press(screen.getByTestId('conversation-search'));
    await waitFor(() => expect(screen.getAllByTestId('conversation-search-recent-row')).toHaveLength(1));
    expect(screen.getByText('배포')).toBeTruthy();

    fireEvent.press(screen.getByTestId('conversation-search-recent-row'));
    await waitFor(() => expect(screen.getByTestId('conversation-search-results')).toBeTruthy(), {timeout: 5_000});
    expect((screen.getByTestId('conversation-search-input').props as {value: string}).value).toBe('배포');

    // 입력칸의 지우기 → 입력 전으로 돌아가 최근 검색이 다시 서고, 「지우기」가 이 대화의 기억을 모두 지운다(키 자체가 없어진다).
    fireEvent.press(screen.getByTestId('conversation-search-clear'));
    await waitFor(() => expect(screen.getByTestId('conversation-search-recent-clear')).toBeTruthy());
    fireEvent.press(screen.getByTestId('conversation-search-recent-clear'));
    await waitFor(() => expect(screen.getByTestId('conversation-search-idle-hint')).toBeTruthy());
    expect(readRecent(WS, GENERAL)).toEqual([]);
    expect(mmkvStore.has('momo.mobile.conversation-search.recent.v1')).toBe(false);
  });

  it('결과를 고르면 그 결과를 낳은 말이 남는다 — 고르기 직전에 더 친 글자는 남기지 않는다', async () => {
    installFetch();
    await search('배포');
    // 디바운스(250ms)가 지나기 전에 한 글자를 더 쳤다 — 화면의 결과는 아직 「배포」의 것이다.
    fireEvent.changeText(screen.getByTestId('conversation-search-input'), '배포 일');
    fireEvent.press(screen.getAllByTestId('conversation-search-result')[0]);
    await waitFor(() => expect(readRecent(WS, GENERAL)).toEqual(['배포']));
  });

});

describe('#5364 대화 안 검색 — DM 은 「이 대화」로 말한다', () => {
  const noop = () => {};
  const fake = (over: Partial<ConversationSearch>): ConversationSearch =>
    ({
      active: true,
      open: noop,
      close: noop,
      view: 'list',
      listOpen: true,
      query: '배포',
      setQuery: noop,
      submit: noop,
      phase: 'results',
      settledQuery: '배포',
      hits: [HIT_103],
      hasMore: false,
      loadingMore: false,
      loadMore: noop,
      retry: noop,
      recent: [],
      pickRecent: noop,
      clearRecent: noop,
      selected: null,
      position: null,
      choose: noop,
      older: noop,
      newer: noop,
      canOlder: false,
      canNewer: false,
      backToList: noop,
      editing: noop,
      ...over,
    }) as ConversationSearch;

  it('입력 안내문과 결과 머리글의 낱말이 DM 과 채널에서 갈린다', () => {
    const directory = makeDirectory([]);
    const view = (isDm: boolean) => (
      <FixedScheme scheme="dark">
        <ConversationSearchRow query="" onChangeQuery={noop} onSubmit={noop} onFocus={noop} onClose={noop} isDm={isDm} />
        <ConversationSearchPanel search={fake({})} directory={directory} selfMemberId={SELF_ID} isDm={isDm} topInset={0} nowMs={T0 + 200_000} />
      </FixedScheme>
    );
    const mounted = render(view(true));
    expect(screen.getByTestId('conversation-search-input').props.placeholder).toBe('이 대화에서 찾기');
    expect(screen.getByTestId('conversation-search-results-head').props.children).toBe('이 대화의 결과 · 최근 순');
    mounted.rerender(view(false));
    expect(screen.getByTestId('conversation-search-input').props.placeholder).toBe('이 채널에서 찾기');
    expect(screen.getByTestId('conversation-search-results-head').props.children).toBe('이 채널의 결과 · 최근 순');
  });
});

describe('#5364 대화 안 검색 — 로그아웃', () => {
  it('로그아웃하면 이 기기에 남은 모든 대화의 최근 검색이 지워진다(다음 사람에게 보일 일이 아니다)', () => {
    rememberRecent(WS, GENERAL, '배포');
    rememberRecent(WS, 'ch-other', '루나');
    expect(readRecent(WS, GENERAL)).toEqual(['배포']);

    // 앱이 실제로 쓰는 `signOut` 을 그 provider 에서 그대로 꺼내 온다.
    let signOut: (() => void) | null = null;
    function Probe(): React.JSX.Element | null {
      signOut = useSession().signOut;
      return null;
    }
    const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}});
    render(
      <QueryClientProvider client={client}>
        <SessionProvider member={SELF}>
          <Probe />
        </SessionProvider>
      </QueryClientProvider>,
    );
    if (signOut === null) throw new Error('signOut 을 잡지 못했다');
    (signOut as () => void)();

    expect(readRecent(WS, GENERAL)).toEqual([]);
    expect(readRecent(WS, 'ch-other')).toEqual([]);
    expect(mmkvStore.has('momo.mobile.conversation-search.recent.v1')).toBe(false);
  });
});
