import type {Member} from '@momo/core/lib/api';
import {centrifugoChannelName} from '@momo/core/lib/realtimeEvents';
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

import {
  clearAgentWorking,
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
import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// 「버벅임」을 숫자로 잠근다 (goal RN-P2a / #997)
//
// 성재, iPhone 17 릴리스 빌드: *"화면이동간에 버벅임, 스크롤 버벅임"*.
//
// ## 왜 프로파일러가 아니라 렌더 수인가
//
// 프레임 시간은 이 자리에서 잴 수 없고(제스트에는 레이아웃도 GPU도 없다), 잴 수
// 있는 기기에서는 재현이 사람의 손가락에 달려 있다. 대신 **원인**은 여기서 정확히
// 셀 수 있다: 이 결함은 "다른 이유로 화면이 다시 그려질 때마다 붙어 있는 메시지
// 행이 전부 다시 그려진다"였고, 그 문장의 참/거짓은 정수 하나다.
//
// 그래서 이 파일은 시간을 재지 않는다. **일어나지 않아야 할 일이 0번 일어났는가**를
// 잰다. 그 0이 성립하려면 아래 네 가지가 동시에 참이어야 하고, 하나만 무너져도
// 숫자가 즉시 올라간다:
//
//   1. `ConversationScreen` 이 리스트에 넘기는 핸들러가 고정된 동일성일 것
//      (인라인 화살표 하나면 끝난다 — `renderItem` 의 의존성이다)
//   2. `Timeline` 이 `ListHeaderComponent`/`ListFooterComponent` 를 새 엘리먼트로
//      만들지 않을 것 (`FlatList` 는 `PureComponent` 다)
//   3. `FlatList` 가 `strictMode` 로 `renderItem` 래퍼를 고정할 것
//      (`FlatList.js:671`,`:682` — 없으면 1·2가 산 것을 이 층이 도로 버린다)
//   4. `MessageRow` 가 memo 될 것 — 데이터가 진짜 바뀔 때 갈리는 유일한 층
//
// ## 계수기가 둘인 이유
//
// 수리가 **어느 층**을 샀는지 말할 수 있어야 한다. `timelineRenderItemCount` 는
// 셀 층(몇 개의 셀이 bail-out 을 잃었는가)을, `messageRowRenderCount` 는 행 본문
// 층을 잰다. 행 memo 하나만 있어도 아래 숫자는 0으로 떨어지지만 위 숫자는 그대로
// 이므로, 하나만 재면 "고쳤다"와 "가렸다"를 구별할 수 없다.
//
// ## 무엇을 가짜로 두는가
//
// `agentWorkingSignal.test.tsx` 와 같다: `fetch` 가 무엇을 답했는가와 소켓이 무엇을
// 실어 왔는가, 둘뿐이다. 화면·스토어·레일·코어는 전부 앱이 그리는 그대로다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const KIM_AGENT = 'cccccccc-1111-4111-8111-cccccccccccc';
const GENERAL = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BASE = 'https://api.example.com';
const BASE_MS = 1_700_000_000_000;

/**
 * 히스토리 길이.
 *
 * 8 인 것은 취향이 아니다. 레이아웃이 없는 제스트에서 `VirtualizedList` 의 렌더
 * 창은 `initialNumToRender`(기본 10)로 결정되고, 파생 스트림은 날짜 구분선 하나를
 * 얹으므로 8 이 **전부 마운트되는 마지막 수**다. 더 길면 꼬리가 창 밖에 있어서
 * "도착한 행 하나만 그려졌다"가 "아무 행도 안 그려졌다"와 구별되지 않는다 — 재는
 * 쪽이 못 재는 것과 통과를 헷갈리는 계측은 계측이 아니다.
 */
const HISTORY_COUNT = 8;

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
    channelIds: [GENERAL],
  }),
];

const CHANNELS = [
  {id: GENERAL, workspaceId: WS, kind: 'public', name: 'general', muted: false},
];

// REST 와 레일은 **다른 표기**로 같은 메시지를 말한다: `/messages` 는 코어의
// `Message` 를 그대로(camelCase) 돌려주고 `isMessage` 로 걸러지며, 발행 프레임은
// snake_case 페이로드로 와서 `payloadToMessage` 를 거친다. 하나로 합치면 둘 중
// 하나가 조용히 버려진다.

function restMessage(seq: number) {
  return {
    id: `msg-${seq}`,
    channelId: GENERAL,
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

function framePayload(seq: number) {
  return {
    id: `msg-${seq}`,
    channel_id: GENERAL,
    seq,
    type: 'text',
    body: `${seq}번째 메시지`,
    author_member_id: KIM_AGENT,
    hlc_ts: seq,
    hlc_count: 0,
    created_at_ms: BASE_MS + seq * 1000,
  };
}

const HISTORY = Array.from({length: HISTORY_COUNT}, (_, i) => restMessage(i + 1));

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
    if (url.includes('/messages')) return jsonResponse(200, {messages: HISTORY});
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
    throw new Error(`unrouted request: ${url}`);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

interface FakeSubscription {
  channel: string;
  __emit: (event: string, ctx: unknown) => void;
}

interface FakeClient {
  getSubscription: (name: string) => FakeSubscription | null;
}

const centrifugeMock = jest.requireMock('centrifuge') as {
  __clients: FakeClient[];
  __reset: () => void;
};

function channelSub(): FakeSubscription | null {
  const clients = centrifugeMock.__clients;
  const last = clients[clients.length - 1];
  return last?.getSubscription(centrifugoChannelName(WS, GENERAL)) ?? null;
}

const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;

let queryClient: QueryClient | null = null;

/** Mount the signed-in tree and open #general, settled. */
async function openConversation() {
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
  // 사이드바에는 채널 줄과 에이전트 줄이 함께 선다(에이전트 줄은 DM 을 연다).
  // 이 계측이 열려는 곳은 **채널** 이다.
  fireEvent.press(screen.getByTestId(`sidebar-row-channel:${GENERAL}`));
  await waitFor(() => expect(screen.getByTestId('timeline-list')).toBeTruthy());
  await waitFor(() =>
    expect(screen.getAllByTestId('message-row').length).toBeGreaterThan(0),
  );
  // Everything the mount set in motion — the head page, the reaction snapshot,
  // the roster, the read-state — has to have landed BEFORE the census starts.
  // A count that begins mid-settle measures the mount, not the defect.
  await settle();
}

/** Let every already-resolved promise and zero-delay timer run out. */
async function settle(ms = 25) {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
}

/** The `renderItem` the list is currently holding — the identity that matters. */
function listRenderItem(): unknown {
  return screen.getByTestId('timeline-list').props.renderItem;
}

/** How many message rows are actually mounted right now. */
function mountedRows(): number {
  return screen.getAllByTestId('message-row').length;
}

beforeEach(() => {
  mmkvStore.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  centrifugeMock.__reset();
  resetAgentWorking();
  sessionPort.applyLogin(LOGIN_BODY);
  installFetch();
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  resetAgentWorking();
});

/** 열린 턴 하나. `over` 로 상태나 헤드라인만 바꾼다. */
function turn(over: Record<string, unknown> = {}) {
  return {
    memberId: KIM_AGENT,
    channelId: GENERAL,
    state: 'working' as const,
    source: 'run' as const,
    runId: 'A1111111-1111-4111-8111-A11111111111',
    startedAtMs: Date.now() - 3_000,
    headlines: [] as string[],
    lastActivityAtMs: Date.now(),
    ...over,
  };
}

describe('대화 화면이 다시 그려질 때 메시지 행이 치르는 값', () => {
  it('턴이 열리면 답이 나타날 칸 하나만 선다 — 기존 메시지 행은 0회', async () => {
    await openConversation();
    resetMessageRowRenderCount();
    resetTimelineRenderItemCount();

    await act(async () => {
      markAgentWorking(turn());
    });
    await settle();

    // 자리표시가 실제로 섰다 (#999).
    expect(screen.getByTestId(`working-row-${KIM_AGENT}`)).toBeTruthy();
    // 데이터가 진짜로 자랐으므로 셀 층은 다시 돈다 — 그것이 이 사건의 정직한 값이다.
    expect(timelineRenderItemCount()).toBeGreaterThan(0);
    // 그러나 **이미 있던 메시지 행**은 한 줄도 다시 그려지지 않는다.
    expect(messageRowRenderCount()).toBe(0);
  });

  it('스트리밍이 흘러도 목록은 한 번도 다시 그려지지 않는다', async () => {
    await openConversation();
    await act(async () => {
      markAgentWorking(turn({headlines: ['빌드 확인 중']}));
    });
    await settle();

    // 여기서부터가 계측 구간이다: 턴은 이미 열려 있고, 이제 바뀌는 것은 헤드라인뿐 —
    // 실기기에서 초당 여러 번 일어나는 바로 그 갱신이다.
    resetMessageRowRenderCount();
    resetTimelineRenderItemCount();

    for (const headline of ['테스트 실행 중', '패치 작성 중', '커밋 중']) {
      await act(async () => {
        markAgentWorking(turn({headlines: [headline]}));
      });
    }
    await settle();

    // 활동 줄은 살아 있다 = 화면은 정말로 다시 그려졌다. 0은 "아무 일도 없었다"가
    // 아니라 "목록에 닿지 않았다"이다.
    expect(screen.getByTestId('composer-working')).toBeTruthy();
    // 두 층 모두 0. 자리표시가 헤드라인이나 시계를 실었다면 여기가 즉시 깨진다 —
    // #999 가 #997 을 되돌리지 못하게 막는 자리가 이 줄이다.
    expect(timelineRenderItemCount()).toBe(0);
    expect(messageRowRenderCount()).toBe(0);
  });

  it('턴이 끝나면 그 칸은 사라진다', async () => {
    await openConversation();
    await act(async () => {
      markAgentWorking(turn());
    });
    await settle();
    expect(screen.getByTestId(`working-row-${KIM_AGENT}`)).toBeTruthy();

    await act(async () => {
      clearAgentWorking(GENERAL, KIM_AGENT);
    });
    await settle();

    // 자리표시가 사라지는 것 자체가 「답이 왔다」의 신호다. 남아 있으면 그것은
    // 끝난 턴을 진행 중이라고 말하는 것이 된다.
    expect(screen.queryByTestId(`working-row-${KIM_AGENT}`)).toBeNull();
  });

  it('승인 대기는 그 칸을 얻지 못한다 — 화면 어디에도 「작업 중」이 없다', async () => {
    await openConversation();
    await act(async () => {
      markAgentWorking(turn({state: 'awaiting_approval', headlines: []}));
    });
    await settle();

    // 멈춰 서서 사람의 결정을 기다리는 턴이다. 답이 나타날 자리를 내주면 화면이
    // "곧 답이 온다"고 말하는 동안 에이전트는 바로 그 사람을 기다리게 된다.
    expect(screen.queryByTestId(`working-row-${KIM_AGENT}`)).toBeNull();
    // 그리고 그 낱말 자체가 화면에 없어야 한다 — 활동 줄은 「승인을 기다립니다」로
    // 말한다. mock 된 문자열이 아니라 코어의 문구를 향한 단정이다.
    expect(screen.queryByText(/작업 중/)).toBeNull();
    expect(screen.getByText(/승인을 기다립니다/)).toBeTruthy();
  });

  it('메시지가 하나 도착하면 그 한 행만 그려진다 — 나머지는 0', async () => {
    await openConversation();
    const before = mountedRows();
    resetMessageRowRenderCount();
    resetTimelineRenderItemCount();

    await act(async () => {
      channelSub()?.__emit('publication', {
        data: {
          type: 'message.new',
          v: 1,
          ts: BASE_MS + 99_000,
          seq: 99,
          payload: framePayload(99),
        },
      });
    });
    await settle();

    expect(mountedRows()).toBe(before + 1);
    // 셀 층은 전부 다시 그려진다 — `buildTimelineItems` 가 항목 객체를 모두 새로
    // 만들기 때문이고, 그것은 이 수리의 대상이 아니다(순수 함수의 정직한 출력이다).
    expect(timelineRenderItemCount()).toBeGreaterThan(1);
    // 도착한 행 하나. `buildTimelineItems` 는 항목 객체를 **전부** 새로 만들므로
    // 모든 셀이 `renderItem` 을 다시 부르지만, 값이 같은 행은 memo 에서 멈춘다.
    // 이 숫자가 `before + 1` 이 되는 순간이 그 memo 가 죽은 순간이다.
    expect(messageRowRenderCount()).toBe(1);
  });

  it('리스트가 들고 있는 renderItem 은 화면이 다시 그려져도 같은 함수다', async () => {
    await openConversation();
    // 턴을 먼저 연다: 칸이 하나 서는 것은 데이터 변화이고, 그때 리스트가 다시
    // 그려지는 것은 옳다. 재려는 것은 그 **다음**부터다.
    await act(async () => {
      markAgentWorking(turn());
    });
    await settle();
    const first = listRenderItem();
    expect(typeof first).toBe('function');

    await act(async () => {
      markAgentWorking(turn({headlines: ['패치 작성 중']}));
    });
    await settle();

    // 이 단정이 위의 두 숫자보다 **먼저** 깨진다. `ConversationScreen` 이 인라인
    // 화살표를 하나라도 되돌리면(`onResend={m => …}`) 여기서 잡히고, 그때는 아직
    // 왜 느린지가 아니라 무엇이 풀렸는지가 보인다.
    expect(listRenderItem()).toBe(first);
  });

  it('읽음 커서는 도착한 메시지마다 서버를 때리지 않는다', async () => {
    // 후보 ③(전환 시 쿼리 폭주)의 잠금. `markRead` 는 PUT 하나로 끝나지 않고
    // `read-state` 와 워크스페이스의 모든 `inbox-mentions` 를 무효화하므로, 메시지
    // 하나에 한 번씩 부르면 언제나 마운트돼 있는 사이드바·인박스·탭바가 그 수만큼
    // 다시 조정된다 — 화면을 여는 순간에는 그것이 전환 애니메이션과 겹친다.
    await openConversation();
    const fetchMock = globalThis.fetch as unknown as jest.Mock;
    const readStateWrites = () =>
      fetchMock.mock.calls.filter(
        ([url]) => typeof url === 'string' && url.includes('/read-state'),
      ).length;
    await settle(700);
    const before = readStateWrites();

    // 한 턴이 답을 흘리는 모양: 짧은 간격으로 다섯 프레임.
    for (let seq = 200; seq < 205; seq += 1) {
      await act(async () => {
        channelSub()?.__emit('publication', {
          data: {
            type: 'message.new',
            v: 1,
            ts: BASE_MS + seq * 1000,
            seq,
            payload: framePayload(seq),
          },
        });
        await new Promise(resolve => setTimeout(resolve, 20));
      });
    }
    await settle(700);

    // 다섯 개가 도착했고, 커서는 **마지막 한 번**으로 접힌다. 서버가 클램프하고
    // 뒤로 가지 않으므로 마지막 값 하나면 뜻이 온전하다.
    const writes = readStateWrites() - before;
    expect(writes).toBeGreaterThan(0);
    expect(writes).toBeLessThanOrEqual(2);
  });

  it('창이 닫히기 전에 화면을 떠나도 커서는 보고된다 — 버리지 않는다 (1R M1)', async () => {
    // 코얼레싱의 대가로 **잃어도 되는 것은 없다.** 600ms 창 안에 채널을 떠나면
    // (빠른 A→B 전환, 뒤로가기) 첫 판은 예약을 통째로 버렸고, 그것은 사람이 이미
    // 읽은 대화에 안 읽음 배지를 남기는 P7 위반이다.
    //
    // 방향의 안전성은 코얼레싱 자체의 논거가 이미 증명한다: 서버가 클램프하고
    // 뒤로 가지 않으므로 **일찍 보내는 것은 언제나 안전**하다. 위험한 것은 안
    // 보내는 쪽뿐이다.
    await openConversation();
    const fetchMock = globalThis.fetch as unknown as jest.Mock;
    const cursorPuts = () =>
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          typeof url === 'string' &&
          url.includes('/read-state') &&
          (init as {method?: string} | undefined)?.method === 'PUT',
      ).length;
    await settle(700);
    const before = cursorPuts();

    // 메시지가 하나 도착한다 — 커서가 예약된다.
    await act(async () => {
      channelSub()?.__emit('publication', {
        data: {
          type: 'message.new',
          v: 1,
          ts: BASE_MS + 300_000,
          seq: 300,
          payload: framePayload(300),
        },
      });
    });

    // 그리고 600ms 가 지나기 **전에** 떠난다. 이것이 결함이 살던 창이다.
    await act(async () => {
      fireEvent.press(screen.getByTestId('header-back'));
    });
    await settle(50);

    // 타이머가 울릴 시간은 없었다. 그래도 보고돼야 한다.
    expect(cursorPuts()).toBe(before + 1);
  });
});
