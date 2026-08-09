import type {Member} from '@momo/core/lib/api';
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
import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// 폰의 점프 앵커 둘 (#1196) — 검색 진입은 **착지**하고, 고정은 **자기 낱말**로 말한다
//
// 폰의 진입 앵커는 여태 고지만 했다: 못 찾으면 「위로 올려 이전 대화를 더
// 불러오세요」를 세우고, **찾으면 아무 일도 하지 않았다** — 찾았는데도 데려가지
// 않았다는 뜻이다. 사람은 채널 바닥에 도착해 방금 읽은 문장을 눈으로 다시 찾는다.
// 웹은 같은 경로에서 착지한다(`?msg=` + `bringIntoView`), 그래서 같은 제품의 두
// 클라이언트가 같은 동작에 다른 규율을 들고 있었다.
//
// ## 이 파일의 red proof 넷
//
//   1. **착지** — 검색 결과를 누르면 타임라인이 그 메시지로 점프를 받는다.
//      수리 전에는 `jumpTarget` 이 영영 `undefined` 라 이 단정이 먼저 깨진다.
//   2. **주어(검색)** — 못 찾았을 때 화면이 「찾던 메시지」라고 말한다. 착지 기계를
//      함께 타게 되면서 고지도 한 벌로 합쳐졌고, 그때 남의 낱말(「인용한 원본」)로
//      말하기 시작하면 이 단정이 깨진다.
//   3. **두 번째 발** — 화면이 시킨 대로 위로 올려 그 줄이 도착하면, 그때 데려간다.
//      한 발만 쏘면 사람은 지시를 따르고도 여전히 눈으로 찾는다.
//   4. **주어(고정)** — 고정 목록에서 못 찾은 점프가 「고정한 메시지」라고 말한다.
//      #1193 이 주어 갈래를 열어 두고 이 호출만 옛 기본값(`'quote'`)에 남겨 두어,
//      고정을 누른 사람이 「인용한 원본」이라는 말을 들었다.
//
// 가짜는 `fetch` 하나뿐이다. 검색 훅·타임라인 훅·화면은 전부 진짜이고, 그래서
// 이 단정들은 「호출했는가」가 아니라 **화면이 무엇을 받았는가**에 대한 것이다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const GENERAL = 'ch-general';
const BASE = 'https://api.example.com';
const T0 = 1_700_000_000_000;

/** 검색이 가리키는 줄. 로드된 머리보다 **한참 아래**(오래된 쪽)에 있다. */
const HIT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const HIT_SEQ = 42;
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

/** 검색이 가리키는 그 줄 자체. 첫 페이지에는 없고, 위로 올려야 온다. */
const HIT_MESSAGE = message(HIT_SEQ, {
  id: HIT_ID,
  body: '배포 로그 확인했습니다',
});

const HEAD_PAGE = [message(HEAD_SEQ), message(HEAD_SEQ + 1)];

const SEARCH_HIT = {
  channelId: GENERAL,
  messageId: HIT_ID,
  authorMemberId: OTHER_ID,
  seq: HIT_SEQ,
  createdAtMs: HIT_MESSAGE.createdAtMs,
  snippet: '배포 로그 확인했습니다',
  matchOffset: 0,
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

/** 로드된 머리에 서 있는 인용. 가리키는 원본(`HIT_ID`)은 아직 안 왔다. */
const QUOTING_MESSAGE = message(HEAD_SEQ + 2, {
  id: 'dddddddd-1111-4111-8111-dddddddddddd',
  body: '그 줄 이야기입니다',
  replyToId: HIT_ID,
  replyTo: {seq: HIT_SEQ},
});

/**
 * 고정 목록 한 건. 가리키는 메시지는 **로드된 페이지에 없다** — 고정은 대개 오래된
 * 줄이고, 그래서 못 찾는 점프는 이 표면의 가장자리가 아니라 상시 경로다.
 */
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

/**
 * `olderPage` 가 있으면 **두 번째 페이지 요청**(`before=`)에만 그것을 답한다.
 * 첫 페이지는 언제나 머리(+ `headExtra`)라, 진입 시점의 화면은 목적지를 들고 있지
 * 않다 — 검색·고정·인용이 정의상 만드는 그 상황이 이 파일의 기본값이다.
 */
function installFetch(
  options: {olderPage?: unknown[]; pins?: unknown[]; headExtra?: unknown[]} = {},
) {
  const mock = jest.fn(async (url: string) => {
    if (url.includes('/search/messages')) {
      return jsonResponse(200, {hits: [SEARCH_HIT]});
    }
    if (url.includes('/pins')) {
      return jsonResponse(200, {pins: options.pins ?? []});
    }
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
      if (url.includes('before=')) {
        return jsonResponse(200, {messages: options.olderPage ?? []});
      }
      return jsonResponse(200, {
        messages: [...HEAD_PAGE, ...(options.headExtra ?? [])],
        nextBefore: HEAD_SEQ,
      });
    }
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/pins')) return jsonResponse(200, {pins: []});
    if (url.includes('/approvals')) return jsonResponse(200, {approvals: []});
    throw new Error(`unrouted request: ${url}`);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

const centrifugeMock = jest.requireMock('centrifuge') as {__reset: () => void};
const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;

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
function jumpTargetOf(): {
  messageId: string;
  seq: number | null;
  token: number;
} | null {
  const nodes = screen.UNSAFE_root.findAll(
    (node: {props?: Record<string, unknown>}) =>
      node.props?.jumpTarget !== undefined,
  );
  const found = nodes[0]?.props?.jumpTarget;
  return (found as {messageId: string; seq: number | null; token: number}) ?? null;
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

/** 사이드바 → 검색 → 결과 한 건 누르기. 사람이 실제로 걷는 길 그대로다. */
async function openFromSearch(): Promise<void> {
  renderShell();
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
  fireEvent.press(screen.getByTestId('open-message-search'));
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

/** 화면이 시킨 것: 위로 올려 이전 대화를 더 불러온다. */
async function pullOlder(): Promise<void> {
  await act(async () => {
    fireEvent(screen.getByTestId('timeline-list'), 'startReached');
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  mmkvStore.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  centrifugeMock.__reset();
  sessionPort.applyLogin(LOGIN_BODY);
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  jest.restoreAllMocks();
});

describe('#1196 — 검색 진입 앵커가 착지한다', () => {
  it('RED PROOF — 결과를 누르면 그 메시지로 점프가 걸린다', async () => {
    // 앵커가 **처음부터 로드돼 있는** 방. 여태 이 경우 화면은 아무 일도 하지
    // 않았다(고지도 안 세우고 데려가지도 않는다) — 그것이 이 이슈다.
    installFetch();
    const mock = globalThis.fetch as unknown as jest.Mock;
    mock.mockImplementation(async (url: string) => {
      if (url.includes('/search/messages')) {
        return jsonResponse(200, {hits: [SEARCH_HIT]});
      }
      if (url.includes('/channels') && !url.includes('/messages')) {
        return jsonResponse(200, {channels: CHANNELS});
      }
      if (url.includes('/roster')) return jsonResponse(200, {members: ROSTER});
      if (url.includes('/read-state')) {
        return jsonResponse(200, {read_states: []});
      }
      if (url.includes('/work-sessions')) {
        return jsonResponse(200, {workSessions: []});
      }
      if (url.includes('/work-hosts')) return jsonResponse(200, {workHosts: []});
      if (url.includes('/messages')) {
        return jsonResponse(200, {messages: [HIT_MESSAGE, ...HEAD_PAGE]});
      }
      if (url.includes('/reactions')) return jsonResponse(200, {});
      if (url.includes('/pins')) return jsonResponse(200, {pins: []});
      if (url.includes('/approvals')) return jsonResponse(200, {approvals: []});
      throw new Error(`unrouted request: ${url}`);
    });

    await openFromSearch();

    await waitFor(() => expect(jumpTargetOf()).not.toBeNull());
    // 기대값을 손으로 적지 않는다 — 검색 결과 픽스처가 정본이다.
    expect(jumpTargetOf()?.messageId).toBe(SEARCH_HIT.messageId);
    // 그리고 **seq 를 함께 싣는다.** 세션 앵커(#1193)와 갈리는 유일한 자리이고,
    // 못 찾았을 때 「더 위쪽에 있다」를 사실로 말할 수 있게 하는 값이다.
    expect(jumpTargetOf()?.seq).toBe(SEARCH_HIT.seq);
    // 착지했으므로 「못 찾았습니다」는 서지 않는다.
    expect(screen.queryByTestId('jump-missed')).toBeNull();
  });

  it('못 찾으면 **찾던 메시지**를 못 찾았다고 말한다 — 남의 낱말이 아니라', async () => {
    // 첫 페이지는 머리 두 줄뿐이고 앵커(seq 42)는 그보다 오래됐다. 그러면
    // 「더 위쪽에 있습니다」는 추측이 아니라 사실이다.
    installFetch();
    await openFromSearch();

    await waitFor(() => expect(screen.getByTestId('jump-missed')).toBeTruthy());
    const notice = jumpMissedNotice('older', 'search');
    expect(screen.getByTestId('jump-missed')).toHaveTextContent(
      new RegExp(notice.headline),
    );
    // 인용을 누른 적 없는 사람에게 인용 이야기를 하지 않는다.
    expect(screen.getByTestId('jump-missed')).not.toHaveTextContent(/인용한 원본/);
    // 고지는 **한 벌**이다. 두 벌이면 못 찾은 한 번에 같은 문장이 두 줄 선다.
    expect(screen.queryByTestId('anchor-missed')).toBeNull();
  });

  it('시킨 대로 위로 올려 그 줄이 도착하면, 그때 데려간다', async () => {
    installFetch({olderPage: [HIT_MESSAGE]});
    await openFromSearch();

    // 첫 발은 빈손이다.
    await waitFor(() => expect(screen.getByTestId('jump-missed')).toBeTruthy());
    expect(jumpTargetOf()?.messageId).toBe(SEARCH_HIT.messageId);
    const firstToken = jumpTargetOf()?.token;

    await pullOlder();

    // 두 번째 발. 같은 목적지지만 **새 요청**이라 토큰이 오른다 — 그래야 목록이
    // 다시 움직인다.
    await waitFor(() =>
      expect(jumpTargetOf()?.token).toBeGreaterThan(firstToken ?? 0),
    );
    expect(jumpTargetOf()?.messageId).toBe(SEARCH_HIT.messageId);
    // 그리고 착지했으므로 상자는 스스로 물러난다 — 그 사라짐이 「도착했다」의
    // 유일한 신호다. 남아 있으면 「아직 불러오지 않았습니다」가 거짓이 된다.
    await waitFor(() => expect(screen.queryByTestId('jump-missed')).toBeNull());
  });
});

// =============================================================================
// #1209 리뷰 High — 같은 상자가 넷에게 하는 같은 약속은 **넷 다** 지켜져야 한다
//
// 첫 판은 이 결말을 검색에만 달았다. 실측이 그것을 그대로 말했다:
//
//   [probe] search: token 1 -> 2 | 고지 살아있나: false
//   [probe] pin   : token 1 -> 1 | 고지 살아있나: true
//
// 고정·인용에서는 사람이 시킨 대로 위로 올려 그 줄이 화면에 도착해도 아무 일이
// 없었고, 상자는 그 자리에 서서 이미 거짓이 된 문장을 계속 말했다.
// =============================================================================

describe('#1209 High — 네 갈래 전부 두 발이다', () => {
  it('고정 목록 점프도 그 줄이 도착하면 데려가고, 상자는 물러난다', async () => {
    installFetch({pins: [PINNED_WIRE], olderPage: [HIT_MESSAGE]});
    await openConversation();

    fireEvent.press(screen.getByTestId('open-pin-list'));
    await waitFor(() => expect(screen.getByTestId('pin-list')).toBeTruthy());
    fireEvent.press(screen.getAllByTestId('pin-list-item')[0]);

    await waitFor(() => expect(screen.getByTestId('jump-missed')).toBeTruthy());
    const firstToken = jumpTargetOf()?.token;

    await pullOlder();

    await waitFor(() =>
      expect(jumpTargetOf()?.token).toBeGreaterThan(firstToken ?? 0),
    );
    expect(jumpTargetOf()?.messageId).toBe(HIT_ID);
    await waitFor(() => expect(screen.queryByTestId('jump-missed')).toBeNull());
  });

  it('인용 점프도 마찬가지다 — 주어별로 다르게 굴 이유가 없다', async () => {
    // 인용은 머리에 서 있고, 그것이 가리키는 원본만 아직 안 왔다.
    installFetch({headExtra: [QUOTING_MESSAGE], olderPage: [HIT_MESSAGE]});
    await openConversation();

    await waitFor(() => expect(screen.getByTestId('quote-block')).toBeTruthy());
    fireEvent.press(screen.getByTestId('quote-block'));

    await waitFor(() => expect(screen.getByTestId('jump-missed')).toBeTruthy());
    // 주어는 여전히 자기 것이다 — 결말을 공유한다고 낱말까지 섞이지 않는다.
    expect(screen.getByTestId('jump-missed')).toHaveTextContent(/인용한 원본/);
    const firstToken = jumpTargetOf()?.token;

    await pullOlder();

    await waitFor(() =>
      expect(jumpTargetOf()?.token).toBeGreaterThan(firstToken ?? 0),
    );
    expect(jumpTargetOf()?.messageId).toBe(HIT_ID);
    await waitFor(() => expect(screen.queryByTestId('jump-missed')).toBeNull());
  });
});

// =============================================================================
// #1209 리뷰 Medium — 「닫기」는 뒤에 걸린 의도도 무른다
//
// 이 배치가 이 고지에 처음으로 「기다렸다가 데려간다」를 달았고, 그 순간 닫기의
// 뜻이 하나 늘었다. 닫기만 하고 기다림을 남기면 상자를 물리고 자기 이유로 옛
// 대화를 읽으러 올라간 사람을 그 줄이 도착하는 순간 읽던 자리에서 끌어간다.
// =============================================================================

describe('#1209 Medium — 닫으면 기다림도 접힌다', () => {
  it('상자를 물린 뒤에는 그 줄이 도착해도 끌려가지 않는다', async () => {
    installFetch({olderPage: [HIT_MESSAGE]});
    await openFromSearch();

    await waitFor(() => expect(screen.getByTestId('jump-missed')).toBeTruthy());
    const firstToken = jumpTargetOf()?.token;

    // 사람이 상자를 물린다 — 「이 점프는 됐다」.
    fireEvent.press(screen.getByTestId('jump-missed-dismiss'));
    await waitFor(() => expect(screen.queryByTestId('jump-missed')).toBeNull());

    // 그리고 자기 이유로 옛 대화를 읽으러 올라간다. 그 줄이 함께 도착한다.
    await pullOlder();

    // 읽던 자리에 그대로 있다. 무른 의도의 결과가 나중에 튀어나오지 않는다.
    expect(jumpTargetOf()?.token).toBe(firstToken);
    expect(screen.queryByTestId('jump-missed')).toBeNull();
  });
});

describe('#1196 — 고정 목록 점프는 자기 낱말로 말한다', () => {
  it('RED PROOF — 「인용한 원본」이 아니라 「고정한 메시지」다', async () => {
    // #1193 이 주어 갈래를 열고 이 호출만 옛 기본값에 남겨 두었다. 고정을 누른
    // 사람은 인용을 누른 적이 없고, 그 화면에서 「인용한 원본」은 **거짓**이다.
    installFetch({pins: [PINNED_WIRE]});
    await openConversation();

    fireEvent.press(screen.getByTestId('open-pin-list'));
    await waitFor(() => expect(screen.getByTestId('pin-list')).toBeTruthy());
    fireEvent.press(screen.getAllByTestId('pin-list-item')[0]);

    await waitFor(() => expect(screen.getByTestId('jump-missed')).toBeTruthy());
    // 고정 목록 항목은 seq 를 **언제나** 든다. 그래서 「더 위쪽에 있다」는 추측이
    // 아니라 사실이고, 기대 문장도 그 갈래에서 나온다.
    const notice = jumpMissedNotice('older', 'pin');
    expect(screen.getByTestId('jump-missed')).toHaveTextContent(
      new RegExp(notice.headline),
    );
    expect(screen.getByTestId('jump-missed')).not.toHaveTextContent(/인용한 원본/);
    // 검색 주어를 빌려 쓰지도 않는다 — 셋은 서로 다른 것을 찾고 있다.
    expect(screen.getByTestId('jump-missed')).not.toHaveTextContent(/찾던 메시지/);
  });
});
