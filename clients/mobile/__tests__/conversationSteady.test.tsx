import type {Member} from '@momo/core/lib/api';
import {
  centrifugoChannelName,
  centrifugoTypingChannelName,
} from '@momo/core/lib/realtimeEvents';
import {RECOVERY_MARKER_TTL_MS} from '@momo/core/features/timeline/divider';
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
import {AppState, FlatList, StyleSheet} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {
  markAgentWorking,
  resetAgentWorking,
} from '../src/features/agents/workingSignal';
import {
  messageRowRenderCount,
  resetMessageRowRenderCount,
} from '../src/features/conversation/MessageRow';
import {
  resetTimelineRenderItemCount,
  timelineRenderItemCount,
} from '../src/features/conversation/Timeline';
import {DISPLAY_GRACE_MS} from '../src/realtime/connectionDisplay';
import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';
import {openPinList} from './fixtures/conversationMenu';
import {
  installAppClock,
  SHELL_WAIT_TEST_TIMEOUT_MS,
} from './fixtures/fakeClock';

// =============================================================================
// 대화 목록은 **서버·소켓이 흔들려도** 제자리를 지킨다 (#4292, 베타 피드백 10-23).
//
// 베타 테스터 둘이 같은 DM 을 열어 둔 채 같은 시각에 대화 화면이 저절로 다시 그려지며 위아래로 흔들렸다고 보고했다. 메시지는
// 아무도 안 보냈다. 두 기기에서 동시에 났으니 기기 하나의 문제가 아니라 **서버 쪽 소켓 흔들림**이 둘에게 한꺼번에 닿은 것이다
// (소켓 churn 은 2026-09-26 RCA 가 이미 잰 현상이다: `centrifugeChurnRepro.test.ts`). 흔들림의 방아쇠는 엔진 쪽(접속 토큰이 바뀌는
// 순간 구독이 거절된다, #4311)이고 거기서 고친다 — 이 시험은 **방아쇠가 남아 있어도 목록이 제자리를 지키는 것**을 잠근다.
//
// ## 무엇이 목록을 움직였나
//
// 재연결 한 번마다 이 화면은 **메시지가 하나도 안 왔는데도** 「재연결됨, 여기까지 복구」 표지 행을 세웠다. `useTimeline` 이
// 복구된 메시지가 0개여도(`recovered: true` 인데 되쏘기가 비었거나, REST 꼬리 읽기가 빈손이거나) 표지를 달았다. 맨 아래에 행이
// 하나 붙었다가 12초 뒤 걷힌다 — 따라가는 목록이 그 행만큼 미끄러졌다 되돌아오고, 연결 띠가 걷히는 순간과 겹치면 한 번에
// 80~120pt 를 튕겼다. 시뮬레이터 실측(`measure/steady.tsx`, 맨 아래 행의 창 좌표를 프레임마다): 메시지 0개로 재연결 세 번에
// 이동 합 772pt · 반전 10회(수리 뒤 73pt · 1회).
//
// 예전 연결 띠(4초 넘는 끊김에서만 섰다)도 목록을 움직였다. 머리 밑 **흐름 안**에 서서 머리가 36.7pt 자라 목록의 보이는 높이가 그만큼
// 줄었다 돌아왔고, 목록은 그 변화를 한 프레임 늦게 알아채 끝으로 따라가므로 그 한 프레임 동안 맨 아래 줄이 36.7pt 밀렸다 돌아왔다
// (시뮬레이터 실측). 지금은 띠가 목록 위에 **뜬다** — 아래 마지막 묶음이 그 구조(흐름 밖 층 + 머리 뿌리 `zIndex`)를 잠근다. 제스트에는
// 레이아웃이 없어 높이 자체는 못 잰다: 「높이 변화 0」의 증거는 PR 본문의 시뮬레이터 표(`measure/steady.tsx`)이고, 이 시험은 그 0 을
// 만드는 **메커니즘**이 사라지면 빨개진다. **정직한** 표지가 12초 뒤 걷히며 목록이 30pt 한 프레임 보정되는 것(#4016 의 설계)은
// 여기서 잠그지 않는다.
//
// ## 이 파일이 재는 것
//
// 제스트에는 레이아웃이 없다. 그래서 **원인이 목록에 닿는 길**을 센다 — 메시지가 오지 않는 동안:
//   (a) 목록에 행이 붙은 적이 있는가(= 콘텐츠 길이가 바뀐 횟수, 표지가 **한 번이라도 섰는가**),
//   (b) 그 때문에 목록이 낸 스크롤 보정 수(`scrollToEnd` + `scrollToOffset`),
//   (c) 셀이 다시 그려진 횟수.
// 세 수가 전부 0 이어야 한다. 반대쪽도 잠근다: 정말로 놓쳤다가 되찾으면 표지는 서고(복구가 일어났다는 말은 참일 때 한다), 그때
// 보정 수는 0 이 아니다 — 그래야 위의 0 이 「못 세서 0」이 아니다.
//
// **시계**: 이 파일의 시험은 마운트 뒤 가짜 시계로 60초를 넘기지 않는다. `useNow` 가 분 단위로 `nowMs` 를 바꾸면 목록의 모든
// 행이 시각 라벨을 위해 한 번 다시 그려진다(레이아웃은 그대로) — 그것은 이 이슈의 원인이 아니고, 넘기면 셀 수 0 단정이 그것을
// 센다. 실측으로도 확인했다(탐침: 한 번의 분 틱이 셀 9 · 행 8).
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const PEER_ID = 'cccccccc-1111-4111-8111-cccccccccccc';
const DM = 'dddddddd-1111-4111-8111-dddddddddddd';
const OTHER_CHANNEL = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BASE = 'https://api.example.com';
const BASE_MS = 1_700_000_000_000;
const HISTORY_COUNT = 8;

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
  rosterMember({id: SELF_ID, displayName: '이도현', handle: 'dohyun'}),
  rosterMember({id: PEER_ID, displayName: '박서연', handle: 'seoyeon'}),
];

const CHANNELS = [
  {
    id: DM,
    workspaceId: WS,
    kind: 'dm',
    dmKey: 'a',
    memberIds: [SELF_ID, PEER_ID],
    muted: false,
  },
];

function restMessage(seq: number, author?: string) {
  return {
    id: `msg-${seq}`,
    channelId: DM,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: author ?? (seq % 2 === 0 ? SELF_ID : PEER_ID),
    type: 'text',
    body: `${seq}번째 메시지`,
    state: 'sent',
    createdAtMs: BASE_MS + seq * 1000,
  };
}

function frame(seq: number, author: string = PEER_ID) {
  return {
    type: 'message.new',
    v: 1,
    ts: BASE_MS + seq * 1000,
    seq,
    payload: {
      id: `msg-${seq}`,
      channel_id: DM,
      seq,
      type: 'text',
      body: `${seq}번째 메시지`,
      author_member_id: author,
      hlc_ts: seq,
      hlc_count: 0,
      created_at_ms: BASE_MS + seq * 1000,
    },
  };
}

/** 서버가 가진 메시지. 시험이 덧붙이면 REST 읽기가 그것을 답한다. */
let serverMessages = Array.from({length: HISTORY_COUNT}, (_, i) => restMessage(i + 1));

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function installFetch(): jest.Mock {
  const mock = jest.fn(async (url: string) => {
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/pins')) return jsonResponse(200, {pins: []});
    if (url.includes('/messages')) {
      const after = /[?&]after=(\d+)/.exec(url);
      if (after !== null) {
        const seq = Number(after[1]);
        return jsonResponse(200, {messages: serverMessages.filter(m => m.seq > seq)});
      }
      return jsonResponse(200, {messages: serverMessages});
    }
    if (url.includes('/channels') && !url.includes('/messages')) {
      return jsonResponse(200, {channels: CHANNELS});
    }
    if (url.includes('/roster')) return jsonResponse(200, {members: ROSTER});
    if (url.includes('/read-state')) return jsonResponse(200, {read_states: []});
    if (url.includes('/work-sessions')) return jsonResponse(200, {workSessions: []});
    if (url.includes('/work-hosts')) return jsonResponse(200, {workHosts: []});
    if (url.includes('/profile')) {
      return jsonResponse(403, {error: {message: 'agent owner required'}});
    }
    if (url.includes('/allowed-models')) {
      return jsonResponse(200, {allowedAgentModels: []});
    }
    if (url.includes('/inbox') || url.includes('/approvals')) {
      return jsonResponse(200, {mentions: [], approvals: [], items: []});
    }
    return jsonResponse(200, {});
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

interface FakeSubscription {
  channel: string;
  __emit: (event: string, ctx: unknown) => void;
  __subscribed: (o?: {recovered?: boolean; publications?: unknown[]}) => void;
}

interface FakeClient {
  state: string;
  subs: Map<string, FakeSubscription>;
  getSubscription: (name: string) => FakeSubscription | null;
  __emit: (event: string, ctx: unknown) => void;
}

const centrifugeMock = jest.requireMock('centrifuge') as {
  __clients: FakeClient[];
  __reset: () => void;
};

function socket(): FakeClient {
  const clients = centrifugeMock.__clients;
  return clients[clients.length - 1];
}

function channelSubscription(): FakeSubscription {
  const sub = socket().getSubscription(centrifugoChannelName(WS, DM));
  if (sub === null) throw new Error('the DM subscription is not up');
  return sub;
}

const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;

let queryClient: QueryClient | null = null;

async function settle(ms = 25) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

/**
 * 네이티브가 하는 일 하나를 **손으로** 한다: 콘텐츠 길이가 바뀌면 `onContentSizeChange` 로 알린다. 제스트에는 이 보고가 없어서,
 * 행이 붙거나 걷혀도 목록이 그것을 알아채고 끝으로 따라가는 길이 한 번도 돌지 않는다. 그 길을 돌려야 「목록이 낸 보정 수」를
 * 잴 수 있다. 뷰포트(`onLayout`)는 방을 열 때 한 번만 알린다 — 연결 띠가 목록의 높이를 바꾸지 않는다는 것은 마지막 묶음이 구조로
 * 잠근다(위 머리말).
 */
const ROW_PT = 60;
const VIEWPORT_PT = 640;

interface Probe {
  /** 지금 목록에 서 있는 행의 수(날짜 구분선·표지 포함). */
  items: () => number;
  /** 훑는 동안 표지 행이 **한 번이라도** 서 있던 최대 수. 「끝에 없다」가 아니라 「온 적이 없다」를 묻는다. */
  maxRecoveryRows: () => number;
  /** 지금까지 콘텐츠 길이가 바뀌어 네이티브가 알린 횟수(열기 뒤). */
  contentChanges: () => number;
  /** 지금까지 목록이 낸 스크롤 보정(`scrollToEnd` + `scrollToOffset`) 수. */
  corrections: () => number;
  /** 한 번 훑는다: 네이티브가 하는 보고를 대신 낸다. */
  look: () => void;
}

function startProbe(): Probe {
  const toEnd = jest.spyOn(FlatList.prototype, 'scrollToEnd');
  const toOffset = jest.spyOn(FlatList.prototype, 'scrollToOffset');
  let lastItems = -1;
  let changes = 0;
  let maxRecovery = 0;
  const list = () => screen.getByTestId('timeline-list');
  const data = () => (list().props.data ?? []) as {kind: string}[];
  const look = () => {
    const rows = data().length;
    maxRecovery = Math.max(
      maxRecovery,
      data().filter(item => item.kind === 'recovery').length,
    );
    if (rows !== lastItems) {
      if (lastItems >= 0) changes += 1;
      lastItems = rows;
      fireEvent(list(), 'contentSizeChange', 390, rows * ROW_PT);
    }
  };
  return {
    items: () => data().length,
    maxRecoveryRows: () => maxRecovery,
    contentChanges: () => changes,
    corrections: () => toEnd.mock.calls.length + toOffset.mock.calls.length,
    look,
  };
}

/** DM 을 열고 첫 페이지·구독·진입 수렴이 가라앉을 때까지. 이 뒤의 변화만 센다. */
async function openDm(): Promise<Probe> {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {retry: false, gcTime: 0},
      mutations: {retry: false, gcTime: 0},
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AppShell member={SELF} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
  fireEvent.press(screen.getByTestId(`sidebar-row-dm:${DM}`));
  await waitFor(() => expect(screen.getByTestId('timeline-list')).toBeTruthy());
  await waitFor(() =>
    expect(screen.getAllByTestId('message-row').length).toBeGreaterThan(0),
  );
  const probe = startProbe();
  probe.look();
  // 목록이 뷰포트를 아는 상태로 만든다(따라가기 활강이 끝을 셈하려면 둘 다 알아야 한다).
  fireEvent(screen.getByTestId('timeline-list'), 'layout', {
    nativeEvent: {layout: {x: 0, y: 0, width: 390, height: VIEWPORT_PT}},
  });
  // 진입 수렴: 첫 보고를 낸 뒤 콘텐츠가 가만히 있을 때까지(`ENTRY_QUIET_MS`)와 착지 유지(`LANDING_HOLD_MS`)를 보낸다.
  fireEvent.scroll(screen.getByTestId('timeline-list'), {
    nativeEvent: {
      contentOffset: {y: probe.items() * ROW_PT - VIEWPORT_PT},
      contentSize: {height: probe.items() * ROW_PT, width: 390},
      layoutMeasurement: {height: VIEWPORT_PT, width: 390},
    },
  });
  await settle(1_000);
  // 방을 연 것이 첫 구독이다. 이 뒤의 재구독부터가 재연결이다.
  await act(async () => {
    channelSubscription().__subscribed({recovered: false});
  });
  await settle(200);
  probe.look();
  return probe;
}

jest.setTimeout(SHELL_WAIT_TEST_TIMEOUT_MS);

beforeEach(() => {
  installAppClock();
  mmkvStore.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  centrifugeMock.__reset();
  resetAgentWorking();
  serverMessages = Array.from({length: HISTORY_COUNT}, (_, i) => restMessage(i + 1));
  sessionPort.applyLogin(LOGIN_BODY);
  installFetch();
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  resetAgentWorking();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

/** 소켓이 죽었다가 이어지고 모든 구독이 다시 구독된다. 10초 유예를 넘으면 연결 중 띠가 끊김 문장으로 바뀐다. */
async function reconnect(
  probe: Probe,
  options: {outageMs: number; recovered: boolean; publications?: unknown[]},
) {
  const client = socket();
  await act(async () => {
    client.state = 'connecting';
    client.__emit('connecting', {code: 1, reason: 'transport closed'});
  });
  probe.look();
  await settle(options.outageMs);
  probe.look();
  await act(async () => {
    client.state = 'connected';
    client.__emit('connected', {});
    const sub = channelSubscription();
    sub.__subscribed({
      recovered: options.recovered,
      publications: options.publications ?? [],
    });
    for (const other of client.subs.values()) {
      if (other !== sub) other.__subscribed({recovered: options.recovered});
    }
  });
  // 표지가 선다면 꼬리 읽기가 돌아오는 즉시 선다. 서는지 두 박자 지켜본다.
  for (let look = 0; look < 4; look += 1) {
    await settle(500);
    probe.look();
  }
}

describe('메시지가 오지 않는 동안 목록은 제자리다', () => {
  it('복구할 것이 없는 재연결은 — 짧은 끊김이든 띠가 서는 끊김이든 — 목록에 아무것도 붙이지 않는다', async () => {
    const probe = await openDm();
    const fetchMock = globalThis.fetch as unknown as jest.Mock;
    const tailReads = () =>
      fetchMock.mock.calls.filter(
        ([url]) => typeof url === 'string' && url.includes('after='),
      ).length;
    const rowsAtRest = probe.items();
    const changesAtRest = probe.contentChanges();
    const correctionsAtRest = probe.corrections();
    const tailReadsAtRest = tailReads();
    resetMessageRowRenderCount();
    resetTimelineRenderItemCount();

    // 네 번: 유예 안에 이어지는 끊김(되쏘기 성공, 받은 것 없음) · 유예 넘는 끊김(되쏘기 실패, REST 꼬리가 빈손)을 번갈아.
    for (let cycle = 0; cycle < 4; cycle += 1) {
      await reconnect(probe, {
        outageMs: cycle % 2 === 0 ? 1_000 : DISPLAY_GRACE_MS + 1_000,
        recovered: cycle % 2 === 0,
      });
    }

    // 되쏘기에 실패한 두 번은 REST 꼬리를 **실제로 읽었다** — 이 시험이 그 길을 타지 않은 채 0 을 말하고 있지 않다.
    expect(tailReads() - tailReadsAtRest).toBeGreaterThanOrEqual(2);
    // (a) 행이 붙은 적도 걷힌 적도 없다. 표지는 한 번도 서지 않았다.
    expect(probe.maxRecoveryRows()).toBe(0);
    expect(probe.items()).toBe(rowsAtRest);
    expect(probe.contentChanges() - changesAtRest).toBe(0);
    // (b) 그래서 목록은 스크롤을 보정할 일이 없었다.
    expect(probe.corrections() - correctionsAtRest).toBe(0);
    // (c) 셀도 다시 그려지지 않았다.
    expect(timelineRenderItemCount()).toBe(0);
    expect(messageRowRenderCount()).toBe(0);
  });

  it('타이핑·다른 방의 작업 신호·앱 전환이 쏟아져도 목록은 한 번도 다시 그려지지 않는다', async () => {
    const probe = await openDm();
    const appStateHandlers: ((status: string) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _event: string,
      fn: (status: string) => void,
    ) => {
      appStateHandlers.push(fn);
      return {remove: () => undefined};
    }) as never);
    const changesAtRest = probe.contentChanges();
    const correctionsAtRest = probe.corrections();
    resetMessageRowRenderCount();
    resetTimelineRenderItemCount();

    for (let round = 0; round < 5; round += 1) {
      // 상대가 타이핑한다(3초마다).
      await act(async () => {
        socket()
          .getSubscription(centrifugoTypingChannelName(WS, DM))
          ?.__emit('publication', {
            data: {
              type: 'ephemeral.typing',
              v: 1,
              ts: Date.now(),
              payload: {
                workspace_id: WS,
                channel_id: DM,
                member_id: PEER_ID,
                expires_at: Date.now() + 6_000,
              },
            },
          });
      });
      // 다른 방에서 에이전트의 대기 실행이 5시간째 서 있고, 그 신호가 갱신된다(#4284).
      await act(async () => {
        markAgentWorking({
          memberId: 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee',
          channelId: OTHER_CHANNEL,
          state: 'queued',
          source: 'run',
          runId: 'B1111111-1111-4111-8111-B11111111111',
          headlines: [],
          lastActivityAtMs: Date.now() + round,
          server: {
            phase: 'queued',
            leaseState: 'none',
            queuedAtMs: Date.now() - 5 * 3_600_000,
            queuePosition: round + 1,
          },
        } as never);
      });
      // 알림 센터를 내렸다 올린다.
      await act(async () => appStateHandlers.forEach(fn => fn('inactive')));
      await act(async () => appStateHandlers.forEach(fn => fn('active')));
      await settle(3_000);
      probe.look();
    }

    expect(probe.maxRecoveryRows()).toBe(0);
    expect(probe.contentChanges() - changesAtRest).toBe(0);
    expect(probe.corrections() - correctionsAtRest).toBe(0);
    expect(timelineRenderItemCount()).toBe(0);
    expect(messageRowRenderCount()).toBe(0);
  });
});

describe('정말로 놓쳤다가 되찾으면 표지는 선다', () => {
  it('끊긴 사이 온 메시지를 REST 꼬리로 되찾으면 「복구」 표지가 서고 12초 뒤 걷힌다', async () => {
    const probe = await openDm();
    const rowsBefore = probe.items();
    const correctionsBefore = probe.corrections();

    // 끊긴 사이 상대가 한 줄을 보냈다(소켓은 못 받았고 서버만 안다).
    serverMessages = [...serverMessages, restMessage(HISTORY_COUNT + 1)];
    await reconnect(probe, {outageMs: DISPLAY_GRACE_MS + 1_000, recovered: false});

    // 새 줄 하나 + 표지 하나.
    expect(probe.items()).toBe(rowsBefore + 2);
    expect(probe.maxRecoveryRows()).toBe(1);
    // 목록은 그것을 알아채고 끝으로 따라갔다 — 위 시험의 0 이 「못 세서 0」이 아니라는 증거다.
    expect(probe.corrections() - correctionsBefore).toBeGreaterThan(0);

    for (let left = RECOVERY_MARKER_TTL_MS; left > 0; left -= 1_000) {
      await settle(1_000);
      probe.look();
    }
    // 표지만 걷혔다. 되찾은 줄은 남는다.
    expect(probe.items()).toBe(rowsBefore + 1);
  });

  it('레일이 끊긴 구간을 되쏘아 주면(recovered) 되쏜 메시지가 있을 때만 표지가 선다', async () => {
    const probe = await openDm();
    const rowsBefore = probe.items();

    // 되쏘기에 메시지가 하나 실려 온다.
    await reconnect(probe, {
      outageMs: 1_000,
      recovered: true,
      publications: [frame(HISTORY_COUNT + 1)],
    });

    expect(probe.maxRecoveryRows()).toBe(1);
    expect(probe.items()).toBe(rowsBefore + 2);
  });
});

describe('내가 방금 보낸 줄은 복구한 것이 아니다 (실기 사례 2026-10-24)', () => {
  it('앱을 다시 열자마자 보낸 내 두 줄이 되쏘기·꼬리 읽기로 돌아와도 표지가 서지 않는다 — 줄은 한 번씩 들어온다', async () => {
    // 백그라운드에서 돌아와 소켓이 다시 붙는 중에 사람이 두 줄을 보냈다. 재구독이 복구되자 **내가 보낸 두 줄 아래에** 「재연결됨, 여기까지
    // 복구」 표지가 붙었다(운영 로그에는 그 시간대 오류 0건). 복구가 들여온 것이 내 줄뿐이면 복구한 것이 없다.
    const probe = await openDm();
    const rowsBefore = probe.items();

    // (a) 되쏘기: 레일이 끊긴 구간의 내 두 줄을 돌려준다.
    await reconnect(probe, {
      outageMs: 1_000,
      recovered: true,
      publications: [frame(HISTORY_COUNT + 1, SELF_ID), frame(HISTORY_COUNT + 2, SELF_ID)],
    });
    expect(probe.items()).toBe(rowsBefore + 2);
    expect(probe.maxRecoveryRows()).toBe(0);

    // (b) 꼬리 읽기: 되쏘기가 실패했고, 서버가 가진 내 두 줄을 REST 가 가져온다(띠가 서는 끊김).
    serverMessages = [
      ...serverMessages,
      restMessage(HISTORY_COUNT + 3, SELF_ID),
      restMessage(HISTORY_COUNT + 4, SELF_ID),
    ];
    await reconnect(probe, {outageMs: DISPLAY_GRACE_MS + 1_000, recovered: false});
    expect(probe.items()).toBe(rowsBefore + 4);
    expect(probe.maxRecoveryRows()).toBe(0);

    // 반대쪽: 같은 자리에서 **남의** 줄이 오면 표지가 선다 — 위의 0 이 「못 세서 0」이 아니다.
    await reconnect(probe, {
      outageMs: 1_000,
      recovered: true,
      publications: [frame(HISTORY_COUNT + 5, PEER_ID)],
    });
    expect(probe.maxRecoveryRows()).toBe(1);
  });
});

describe('연결 띠는 목록의 높이를 바꾸지 않는다', () => {
  /** 스타일 배열·중첩을 한 객체로 편다. */
  const flat = (style: unknown): Record<string, unknown> =>
    (StyleSheet.flatten(style as never) ?? {}) as Record<string, unknown>;

  it('연결 중부터 10초 뒤 끊김까지 띠는 머리 밑에 매달려 목록 위에 뜬다 — 머리의 흐름 높이를 늘리지 않는다', async () => {
    await openDm();
    // 연결돼 있으면 띠가 없다.
    expect(screen.queryByTestId('connection-banner')).toBeNull();

    const client = socket();
    await act(async () => {
      client.state = 'connecting';
      client.__emit('connecting', {code: 1, reason: 'transport closed'});
    });
    // #4783은 복구를 숨기는 대신 10초 동안 「연결 중」을 보인다(PR의 의도된 표시 변경).
    // 띠가 없다는 옛 기대만 문장 전환으로 바꾼다. 두 상태 모두 같은 흐름 밖 층이어야 한다.
    const header = screen.getByTestId('conversation-header');
    const connectingLayer = within(header).getByTestId('connection-banner-layer');
    expect(within(connectingLayer).getByTestId('connection-banner')).toHaveTextContent('연결 중…');
    expect(flat(connectingLayer.props.style)).toMatchObject({position: 'absolute', top: '100%'});
    await settle(DISPLAY_GRACE_MS - 1_000);
    expect(screen.getByTestId('connection-banner')).toHaveTextContent('연결 중…');
    await settle(2_000);

    const banner = within(header).getByTestId('connection-banner');
    expect(banner).toHaveTextContent('연결이 끊겼습니다');

    // (a) 띠를 진 층은 **흐름 밖**이다. 흐름 안에 있으면 띠가 설 때마다 머리가 자라 목록의 보이는 높이가 줄었다 돌아온다.
    const layer = within(header).getByTestId('connection-banner-layer');
    expect(layer).toBe(connectingLayer);
    expect(flat(layer.props.style)).toMatchObject({position: 'absolute', top: '100%'});
    // (b) 알약은 그 층 안에 있다 — 흐름에 끼는 형제로 따로 서 있지 않다.
    expect(within(layer).getByTestId('connection-banner')).toHaveTextContent('연결이 끊겼습니다');
    // (c) 머리 뿌리는 뒤 형제(목록) 위에 그려진다 — 아니면 매달린 띠가 목록 밑으로 숨는다.
    expect(Number(flat(header.props.style).zIndex ?? 0)).toBeGreaterThan(0);
    // (d) 띠 바깥은 손을 받지 않는다 — 알약 밑의 메시지가 눌려야 한다.
    expect(layer.props.pointerEvents).toBe('none');
    // (e) 낭독 속성(역할 · 라이브 리전)은 안쪽 알약에 있고 바깥 층에는 없다 — 층은 손만 막는 포장이다.
    expect(banner.props.accessibilityRole).toBe('text');
    expect(banner.props.accessibilityLiveRegion).toBe('polite');
    expect(layer.props.accessibilityRole).toBeUndefined();
    expect(layer.props.accessibilityLiveRegion).toBeUndefined();

    // 이어지면 띠가 걷힌다.
    await act(async () => {
      client.state = 'connected';
      client.__emit('connected', {});
    });
    await settle(25);
    expect(screen.queryByTestId('connection-banner')).toBeNull();
    expect(screen.queryByTestId('connection-banner-layer')).toBeNull();
  });

  it('띠의 높이는 목록의 위쪽 필 틀로 건너가 필이 띠 밑에 쌓이고, 그 일로 셀은 다시 그려지지 않는다', async () => {
    await openDm();
    const topPills = () => flat(screen.getByTestId('timeline-top-pills').props.style);
    // 띠가 없으면 필은 목록 위 가장자리에 선다.
    expect(topPills().top).toBe(0);
    resetMessageRowRenderCount();
    resetTimelineRenderItemCount();

    const client = socket();
    await act(async () => {
      client.state = 'connecting';
      client.__emit('connecting', {code: 1, reason: 'transport closed'});
    });
    await settle(DISPLAY_GRACE_MS + 1_000);

    // 머리가 띠의 높이를 알린다(네이티브가 하는 보고를 손으로 낸다) — 36.7 은 시뮬레이터 실측값이다.
    const layer = screen.getByTestId('connection-banner-layer');
    await act(async () => {
      fireEvent(layer, 'layout', {nativeEvent: {layout: {x: 0, y: 0, width: 390, height: 36.7}}});
    });
    expect(topPills().top).toBe(36.7);

    // 이어져 띠가 걷히면 필 틀도 제자리로 돌아온다 — 사라진 띠 밑에 필이 떠 있지 않다.
    await act(async () => {
      client.state = 'connected';
      client.__emit('connected', {});
    });
    await settle(25);
    expect(screen.queryByTestId('connection-banner')).toBeNull();
    expect(topPills().top).toBe(0);

    // 필 틀이 두 번 움직이는 동안 목록의 셀은 한 번도 다시 그려지지 않았다.
    expect(timelineRenderItemCount()).toBe(0);
    expect(messageRowRenderCount()).toBe(0);
  });

  it('머리 뿌리의 zIndex 는 한 틀 안에서만 겨룬다 — 열린 고정 목록은 틀 밖 뒤 형제이고, 덮개 쪽에는 zIndex 가 없다', async () => {
    // 머리 뿌리는 띠를 목록 위에 띄우려고 `zIndex` 를 받았다. RN 새 아키텍처에서 `zIndex` 는 형제의 그리기·누르기 순서를 트리 순서보다
    // 앞세우므로(`shellChrome.test.tsx` B1) 머리가 `Screen` 직속이면 전면 덮개(스레드 · 고정 목록 · 작업 목록)가 열려도 머리가 그 위에 그려지고
    // 눌린다 — 대화 머리의 「‹」가 스레드를 닫으려는 손을 받아 대화를 떠난다. 그래서 머리는 목록과 한 틀에 담기고 덮개는 틀 **뒤** 형제다.
    // 그리기·누르기 순서 자체는 제스트가 못 재므로 그 **구조**를 잰다(시뮬레이터 캡처로도 확인한다).
    await openDm();
    expect(screen.queryByTestId('pin-list-pane')).toBeNull();
    // ⋮ 시트의 「고정한 메시지」 행이 고정 목록을 연다(시트가 먼저 내려간 뒤).
    await openPinList();
    expect(screen.queryByTestId('conversation-menu-sheet')).toBeNull();

    const column = screen.getByTestId('conversation-column');
    const header = screen.getByTestId('conversation-header');
    const pane = screen.getByTestId('pin-list-pane');
    // (a) 머리와 목록은 같은 틀 안에 있고, 열린 덮개는 그 틀 **밖**이다.
    expect(within(column).getByTestId('conversation-header')).toBeTruthy();
    expect(within(column).getByTestId('timeline-list')).toBeTruthy();
    expect(within(column).queryByTestId('pin-list-pane')).toBeNull();
    // (b) 틀은 덮개보다 트리에서 **앞**이다 = 덮개가 위에 그려지고 먼저 눌린다.
    const order = screen.UNSAFE_root
      .findAll(
        (node: {props: {testID?: string}}) =>
          ['conversation-column', 'pin-list-pane'].includes(node.props.testID ?? ''),
        {deep: true},
      )
      .map((node: {props: {testID?: string}}) => node.props.testID)
      .filter(
        (id: string | undefined, at: number, all: Array<string | undefined>) =>
          all.indexOf(id) === at,
      );
    expect(order).toEqual(['conversation-column', 'pin-list-pane']);
    // (c) 틀에는 zIndex 가 없다 — 덮개와 겨루지 않는다. 머리 뿌리의 zIndex 는 이 틀 안에서만 목록과 겨룬다.
    expect(flat(column.props.style).zIndex).toBeUndefined();
    // (c2) 틀은 **실제 네이티브 뷰**여야 한다. 시각 속성이 없는 틀은 레이아웃 전용 뷰라 Fabric 이 평탄화하고, 그러면 자식(머리, zIndex 1)이
    // `Screen` 직속 형제와 함께 정렬되어 틀이 아무것도 가두지 못한다 — 제스트에는 평탄화가 없어 이 속성만 못박는다. 실제 그리기는
    // 시뮬레이터 캡처(`steady4292-panel-*`: 틀 있는 `panel` 은 덮개가 위, 틀 없는 `panel-flat` 은 머리가 덮개 위)가 증거다.
    expect(column.props.collapsable).toBe(false);
    expect(Number(flat(header.props.style).zIndex ?? 0)).toBeGreaterThan(0);
    // (d) 덮개 쪽에도 zIndex 가 없다(층은 JSX 순서다): 덮개 자신에서 화면까지 올라가며 어느 노드도 zIndex 를 들고 있지 않다.
    const climbed: unknown[] = [];
    for (let node: typeof pane | null = pane; node !== null; node = node.parent) {
      climbed.push(flat(node.props.style).zIndex);
    }
    expect(climbed.filter(zIndex => zIndex !== undefined)).toEqual([]);
  });
});
