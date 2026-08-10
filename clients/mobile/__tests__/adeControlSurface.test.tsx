import type {Member} from '@momo/core/lib/api';
import {
  ADE_DRAWER_EMPTY_HEADLINE,
  adeSummarySentence,
  durabilityBadge,
} from '@momo/core/features/work/adeControl';
import {centrifugoAgentChannelName} from '@momo/core/lib/realtimeEvents';
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

import {color} from '../src/design/tokens';
import {jumpMissedNotice} from '../src/features/conversation/jumpNotice';
import {resetAgentWorking} from '../src/features/agents/workingSignal';
import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// ADE 관제 — 폰 (이슈 1137, ADR-0154 D2 "폰은 목록형").
//
// ## 무엇을 가짜로 두는가
//
// 둘뿐이다: `fetch` 가 무엇을 답했는가, 소켓이 무엇을 실어 왔는가. 그 아래는 전부
// 진짜다 — 코어의 집계(`adeItems`/`adeCounts`/`adeSummarySegments`), 신호 스토어,
// 세션 원장 질의, 그리고 화면. **집계 함수를 mock 하지 않는 것**이 이 파일의 규율
// 이다: mock 하면 "요약 줄이 두 레일을 합쳐 센다" 가 「호출했는가」에 대한 주장으로
// 약해지는데, 실제로 지켜야 하는 것은 **화면에 나온 문장이 그 합집합**이라는
// 것이다. 그래서 아래 red proof 는 코어에 같은 계수를 직접 물어 문장을 만들고,
// 화면의 문장과 글자 단위로 맞춘다.
//
// ## 두 개의 red proof
//
//   1. **집계 소비 정확** — 요약 줄이 세는 것은 열린 턴 ∪ 작업 세션이고, `idle` 과
//      `ended` 는 빠진다. 어느 한쪽만 세거나 유휴를 세면 문장이 달라진다.
//   2. **레이아웃 불밀림** — 요약 줄이 생기는 것도, 관제 목록이 열리는 것도
//      컴포저·타임라인의 기하를 건드리지 않는다. 줄이 컴포저 액세서리 스택에
//      들어가지 않았다는 사실과, 목록이 흐름에서 폭도 높이도 가져가지 않는다는
//      사실을 각각 렌더 트리에서 읽어 확인한다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const KIM_AGENT = 'cccccccc-1111-4111-8111-cccccccccccc';
const HERMES_AGENT = 'dddddddd-1111-4111-8111-dddddddddddd';
const GENERAL = 'ch-general';
const BUILD = 'ch-build';
const RUN_KIM = 'A1111111-1111-4111-8111-A11111111111';
const RUN_HERMES = 'B2222222-2222-4222-8222-B22222222222';
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
  rosterMember({
    id: KIM_AGENT,
    kind: 'agent',
    displayName: '김인턴',
    handle: 'kim-intern',
    channelCount: 1,
    channelIds: [GENERAL],
    paused: false,
  }),
  rosterMember({
    id: HERMES_AGENT,
    kind: 'agent',
    displayName: 'hermes',
    handle: 'hermes',
    channelCount: 1,
    channelIds: [BUILD],
    paused: false,
  }),
];

const CHANNELS = [
  {id: GENERAL, workspaceId: WS, kind: 'public', name: 'general', muted: false},
  {id: BUILD, workspaceId: WS, kind: 'public', name: 'build', muted: false},
];

/**
 * 원장 픽스처. 네 행이 각각 다른 것을 증명한다:
 *
 *   running   -> working    세션 반쪽이 실제로 세어진다
 *   orphaned  -> blocked    D1 의 "랩탑이 닫혀 중단됨, 이어받기 가능"
 *   idle      -> 목록에는 있으나 **계수에는 없다** (코어 `AdeCounts.total`)
 *   ended     -> 어느 쪽에도 없다
 */
const WORK_SESSIONS = [
  {
    id: 'SESSION-RUNNING',
    workspaceId: WS,
    channelId: GENERAL,
    memberId: KIM_AGENT,
    hostId: 'HOST-CLOUD',
    rootMessageId: 'm-1',
    tool: 'codex',
    label: '타임라인 리팩터링',
    status: 'running',
    observation: 'open',
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    startedAtMs: T0,
  },
  {
    id: 'SESSION-ORPHANED',
    workspaceId: WS,
    channelId: BUILD,
    memberId: KIM_AGENT,
    hostId: 'HOST-APP',
    rootMessageId: 'm-2',
    tool: 'claude',
    label: '야간 배치',
    status: 'orphaned',
    observation: 'open',
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    startedAtMs: T0,
  },
  {
    id: 'SESSION-IDLE',
    workspaceId: WS,
    channelId: GENERAL,
    memberId: KIM_AGENT,
    hostId: 'HOST-APP',
    rootMessageId: 'm-3',
    tool: 'codex',
    label: '릴레이 로그 훑기',
    status: 'idle',
    observation: 'open',
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    startedAtMs: T0,
  },
  {
    id: 'SESSION-ENDED',
    workspaceId: WS,
    channelId: GENERAL,
    memberId: KIM_AGENT,
    hostId: 'HOST-CLOUD',
    rootMessageId: 'm-4',
    tool: 'codex',
    label: '어제 끝난 일',
    status: 'ended',
    observation: 'open',
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    startedAtMs: T0 - 86_400_000,
    endedAtMs: T0 - 80_000_000,
  },
];

function workHost(id: string, type: string, displayName: string) {
  return {
    id,
    workspaceId: WS,
    scope: type === 'app' ? 'member' : 'workspace',
    ownerMemberId: SELF_ID,
    type,
    displayName,
    publicKey: 'k',
    capabilities: {},
    createdAtMs: 0,
    online: true,
  };
}

const WORK_HOSTS = [
  workHost('HOST-APP', 'app', '성재의 맥'),
  workHost('HOST-CLOUD', 'cloud', 'oort Cloud'),
];

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface Routes {
  workSessions?: () => Response | Promise<Response>;
  workHosts?: () => Response | Promise<Response>;
}

interface FetchLog {
  mock: jest.Mock;
  callsTo: (fragment: string) => number;
}

function installFetch(routes: Routes = {}): FetchLog {
  const mock = jest.fn(async (url: string) => {
    if (url.includes('/work-sessions')) {
      return routes.workSessions
        ? routes.workSessions()
        : jsonResponse(200, {workSessions: WORK_SESSIONS});
    }
    if (url.includes('/work-hosts')) {
      return routes.workHosts
        ? routes.workHosts()
        : jsonResponse(200, {workHosts: WORK_HOSTS});
    }
    if (url.includes('/channels') && !url.includes('/messages')) {
      return jsonResponse(200, {channels: CHANNELS});
    }
    if (url.includes('/roster')) return jsonResponse(200, {members: ROSTER});
    if (url.includes('/read-state')) return jsonResponse(200, {read_states: []});
    if (url.includes('/messages')) return jsonResponse(200, {messages: []});
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/approvals')) return jsonResponse(200, {approvals: []});
    throw new Error(`unrouted request: ${url}`);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return {
    mock,
    callsTo: fragment =>
      mock.mock.calls.filter(([url]) => String(url).includes(fragment)).length,
  };
}

interface FakeSubscription {
  __emit: (event: string, ctx: unknown) => void;
}
interface FakeClient {
  getSubscription: (name: string) => FakeSubscription | null;
  __emit: (event: string, ctx: unknown) => void;
}

const centrifugeMock = jest.requireMock('centrifuge') as {
  __clients: FakeClient[];
  __reset: () => void;
};

function client(): FakeClient {
  const clients = centrifugeMock.__clients;
  return clients[clients.length - 1];
}

function agentSub(channelId: string, memberId: string): FakeSubscription | null {
  return (
    client()?.getSubscription(
      centrifugoAgentChannelName(WS, channelId, memberId),
    ) ?? null
  );
}

function statusFrame(
  channelId: string,
  memberId: string,
  runId: string,
  over: Record<string, unknown> = {},
) {
  return {
    type: 'agent.status',
    v: 1,
    ts: Date.now(),
    payload: {
      run_id: runId,
      agent_member_id: memberId,
      channel_id: channelId,
      phase: 'queued',
      run_status: 'queued',
      ...over,
    },
  };
}

/** 구독이 붙은 tick 에 답하지 않는다 (#839). */
async function deliver(
  channelId: string,
  memberId: string,
  data: unknown,
  delayMs: number,
): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    agentSub(channelId, memberId)?.__emit('publication', {data});
  });
}

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

/**
 * 렌더 트리의 한 노드 — 이 파일이 쓰는 만큼만.
 *
 * `react-test-renderer` 는 타입 선언을 싣지 않고(`@types/react-test-renderer` 는 이
 * 프로젝트의 의존성이 아니다) `findAll` 의 콜백 인자는 그래서 암묵적 any 다. 형태를
 * 여기 적는 것이 패키지를 하나 더 들이는 것보다 싸고, 무엇을 읽는지도 드러난다.
 */
interface TreeNode {
  props?: {testID?: unknown};
}

/** 렌더 트리에서 읽는 `testID`. 없는 노드는 빈 문자열이라 비교가 안전하다. */
function testIdOf(node: TreeNode): string {
  const value = node.props?.testID;
  return typeof value === 'string' ? value : '';
}

/** RN style props arrive as a value or a (possibly nested) array. */
function flatStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>(
      (acc, entry) => ({...acc, ...flatStyle(entry)}),
      {},
    );
  }
  return (style as Record<string, unknown> | null | undefined) ?? {};
}

const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;

async function openConversation(channelId = GENERAL): Promise<void> {
  renderShell();
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
  await waitFor(() => expect(agentSub(GENERAL, KIM_AGENT)).toBeTruthy());
  fireEvent.press(screen.getByTestId(`sidebar-row-channel:${channelId}`));
  await waitFor(() =>
    expect(screen.getByTestId('conversation-title')).toBeTruthy(),
  );
}

/** 두 레일 모두에 열린 것을 하나씩 만든다: 실행 중인 턴 하나, 승인 대기 하나. */
async function openBothTurns(): Promise<void> {
  await deliver(GENERAL, KIM_AGENT, statusFrame(GENERAL, KIM_AGENT, RUN_KIM), 20);
  await deliver(
    GENERAL,
    KIM_AGENT,
    statusFrame(GENERAL, KIM_AGENT, RUN_KIM, {
      phase: 'streaming',
      run_status: 'running',
    }),
    40,
  );
  await deliver(
    BUILD,
    HERMES_AGENT,
    statusFrame(BUILD, HERMES_AGENT, RUN_HERMES, {
      phase: 'awaiting_approval',
      run_status: 'awaiting_approval',
    }),
    40,
  );
}

beforeEach(() => {
  mmkvStore.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  centrifugeMock.__reset();
  resetAgentWorking();
  sessionPort.applyLogin(LOGIN_BODY);
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  resetAgentWorking();
  jest.restoreAllMocks();
});

describe('요약 한 줄 — 두 레일의 합집합을 센다', () => {
  it('RED PROOF — 열린 턴과 작업 세션을 함께 세고, 유휴와 종료는 세지 않는다', async () => {
    installFetch();
    await openConversation();
    await openBothTurns();

    await waitFor(() => expect(screen.getByTestId('ade-summary')).toBeTruthy());

    // 기대값을 손으로 적지 않는다. 코어에 같은 계수를 물어 문장을 만들고 그것과
    // 맞춘다 — 화면이 문장을 다시 조립하지 않는다는 것이 이 층의 계약이므로,
    // 단정도 코어를 정본으로 삼아야 같은 것을 지킨다.
    //
    //   세션  running 1 + orphaned 1 (+ idle 1 은 세지 않고, ended 는 목록에도 없다)
    //   턴    running 1 + awaiting_approval 1
    const expected = adeSummarySentence({
      working: 2,
      blocked: 2,
      idle: 1,
      total: 4,
    });
    expect(expected).toBe('실행 중인 작업 2개 · 대기 2');
    expect(screen.getByTestId('ade-summary-text')).toHaveTextContent(
      new RegExp((expected as string).replace(/[·]/g, '\u00b7')),
    );

    // 그리고 그 문장이 **한 레일만** 센 것이 아니라는 것을 반대편에서 한 번 더
    // 못박는다: 턴만 세면 「1개 · 대기 1」, 세션만 세면 같은 값이 나온다. 둘 중
    // 어느 쪽으로 회귀해도 위 단정이 깨지고, 유휴를 세면 「3개」가 된다.
    expect(screen.getByTestId('ade-summary-text')).not.toHaveTextContent(
      /실행 중인 작업 1개/,
    );
    expect(screen.getByTestId('ade-summary-text')).not.toHaveTextContent(
      /실행 중인 작업 3개/,
    );
  });

  it('살아 있는 작업이 없으면 줄 자체가 없다 — 빈 띠도 아니다', async () => {
    installFetch({workSessions: () => jsonResponse(200, {workSessions: []})});
    await openConversation();
    // 턴을 하나도 열지 않는다. 세션도 없다.
    await waitFor(() =>
      expect(screen.getByTestId('conversation-title')).toBeTruthy(),
    );
    expect(screen.queryByTestId('ade-summary')).toBeNull();
    expect(screen.queryByTestId('ade-summary-text')).toBeNull();
  });

  it('유휴 세션만 있으면 줄이 서지 않는다 — 원장이 비지 않았어도', async () => {
    installFetch({
      workSessions: () =>
        jsonResponse(200, {
          workSessions: WORK_SESSIONS.filter(s => s.status === 'idle'),
        }),
    });
    await openConversation();
    await waitFor(() =>
      expect(screen.getByTestId('conversation-title')).toBeTruthy(),
    );
    // 「호스트가 터미널을 열어 두고 있다」는 진행 중인 작업이 아니다. 그것까지
    // 세면 아무 일도 안 일어나는 워크스페이스에서 줄이 영구히 켜져 있다.
    expect(screen.queryByTestId('ade-summary')).toBeNull();
  });

  it('대기만 있으면 「실행 중인 작업 0개」로 시작하지 않는다', async () => {
    installFetch({
      workSessions: () =>
        jsonResponse(200, {
          workSessions: WORK_SESSIONS.filter(s => s.status === 'orphaned'),
        }),
    });
    await openConversation();
    await waitFor(() => expect(screen.getByTestId('ade-summary')).toBeTruthy());
    expect(screen.getByTestId('ade-summary-text')).toHaveTextContent(
      /대기 중인 작업 1개/,
    );
  });
});

describe('레이아웃 — 이 층은 아무것도 밀지 않는다', () => {
  it('RED PROOF — 요약 줄은 컴포저 액세서리 스택 밖에 있고, 목록은 흐름을 차지하지 않는다', async () => {
    installFetch();
    await openConversation();
    await openBothTurns();
    await waitFor(() => expect(screen.getByTestId('ade-summary')).toBeTruthy());

    // ① 줄은 **컴포저 도크 안에 없다.** 안에 있으면 나타나고 사라지는 이 줄이
    //    캐럿과 「중단」 버튼을 밀게 되고, 그것이 design-review H-3 이 자리를
    //    예약해서 막은 바로 그 결함이다 — 그런데 이 줄의 계약은 자리를 예약하지
    //    않는 것이라 예약으로는 막을 수 없다. 자리를 옮기는 것이 유일한 수리다.
    const dock = screen.getByTestId('composer-dock');
    expect(
      dock.findAll((node: TreeNode) => testIdOf(node) === 'ade-summary'),
    ).toHaveLength(0);
    // 그리고 실제로 존재하는 그 스택은 그대로다 — 이 배치가 그 자리를 건드리지
    // 않았다는 사실을 같은 자리에서 확인한다.
    expect(
      dock.findAll((node: TreeNode) => testIdOf(node) === 'composer-working')
        .length,
    ).toBeGreaterThan(0);

    // ② 목록을 열기 전후로 대화의 기하가 **글자 하나 안 바뀐다.**
    const geometryBefore = [
      flatStyle(screen.getByTestId('conversation-clip').props.style),
      flatStyle(screen.getByTestId('conversation-layout').props.style),
    ];

    fireEvent.press(screen.getByTestId('ade-summary'));
    await waitFor(() => expect(screen.getByTestId('ade-card-list')).toBeTruthy());

    const geometryAfter = [
      flatStyle(screen.getByTestId('conversation-clip').props.style),
      flatStyle(screen.getByTestId('conversation-layout').props.style),
    ];
    expect(geometryAfter).toEqual(geometryBefore);
    // 컴포저도 여전히 거기 있다. 목록은 덮을 뿐 갈아 끼우지 않는다.
    expect(screen.getByTestId('composer-dock')).toBeTruthy();

    // ③ 덮는 층은 **절대 배치**다 — 흐름에서 폭도 높이도 가져가지 않는다. 이것이
    //    ②가 참인 **이유**이고, ②만으로는 다음 사람이 그 이유를 알 수 없다.
    //
    //    이름으로 그 판 하나를 집는다. 조상을 훑어 「어딘가에 절대 배치가 있다」로
    //    단정했더니 대화 자신의 오버레이가 걸려서, 이 판을 흐름에 세워도 초록이었다
    //    (실측). 주장이 이 뷰에 대한 것이면 단정도 이 뷰에 대한 것이어야 한다.
    expect(flatStyle(screen.getByTestId('ade-panel-pane').props.style)).toMatchObject(
      {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
      },
    );
  });
});

describe('관제 목록 — 무엇이, 어디서, 살아남는지', () => {
  it('카드가 두 레일을 모두 세우고, 유휴 세션도 목록에는 선다', async () => {
    installFetch();
    await openConversation();
    await openBothTurns();
    await waitFor(() => expect(screen.getByTestId('ade-summary')).toBeTruthy());
    fireEvent.press(screen.getByTestId('ade-summary'));
    await waitFor(() => expect(screen.getByTestId('ade-card-list')).toBeTruthy());

    // 세션 셋(running·orphaned·idle) + 턴 둘. `ended` 는 없다.
    expect(
      screen.getByTestId('ade-card-session|session-orphaned'),
    ).toBeTruthy();
    expect(screen.getByTestId('ade-card-session|session-running')).toBeTruthy();
    expect(screen.getByTestId('ade-card-session|session-idle')).toBeTruthy();
    expect(screen.queryByTestId('ade-card-session|session-ended')).toBeNull();
    expect(
      screen.getByTestId(
        `ade-card-run|${RUN_KIM.toLowerCase()}|${GENERAL.toLowerCase()}`,
      ),
    ).toBeTruthy();

    // 대기가 맨 위다 (D1: 멘션급). 목록의 첫 카드가 그 둘 중 하나여야 한다.
    const cards = screen
      .getByTestId('ade-card-list')
      .findAll((node: TreeNode) => testIdOf(node).startsWith('ade-card-'))
      .map((node: TreeNode) => testIdOf(node))
      .filter((id: string) => id !== 'ade-card-list');
    expect(cards[0]).toMatch(/session\|session-orphaned|run\|/);
    expect(
      screen.getByTestId('ade-card-state-session|session-orphaned'),
    ).toHaveTextContent(/대기/);
    // 3분류 칩과 **원장의 더 정밀한 사실**이 함께 선다.
    expect(
      screen.getByTestId('ade-card-meta-session|session-orphaned'),
    ).toHaveTextContent(/호스트 연결 끊김/);
    // 그리고 카드는 자기 방을 말한다 — 요약이 워크스페이스 전역이라 필수다.
    expect(
      screen.getByTestId('ade-card-meta-session|session-orphaned'),
    ).toHaveTextContent(/build/);
  });

  it('생존성은 등록기가 답한 뒤에만 말한다 — 그 전에는 침묵한다', async () => {
    let releaseHosts: (() => void) | null = null;
    installFetch({
      workHosts: () =>
        new Promise<Response>(resolve => {
          releaseHosts = () =>
            resolve(jsonResponse(200, {workHosts: WORK_HOSTS}));
        }),
    });
    await openConversation();
    await openBothTurns();
    await waitFor(() => expect(screen.getByTestId('ade-summary')).toBeTruthy());
    fireEvent.press(screen.getByTestId('ade-summary'));
    await waitFor(() => expect(screen.getByTestId('ade-card-list')).toBeTruthy());

    // 「아직 안 물어봤다」를 「실행 위치 확인 필요」로 그리면 이 화면은 열릴 때마다
    // 모든 카드에 경고를 하나씩 달고 뜬 다음 조용히 지운다.
    expect(
      screen.queryByTestId('ade-card-durability-session|session-running'),
    ).toBeNull();

    await act(async () => {
      releaseHosts?.();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        screen.getByTestId('ade-card-durability-session|session-running'),
      ).toBeTruthy(),
    );
    // 클라우드 호스트는 「기기를 꺼도 계속됩니다」를 말할 자격이 있고, 그 문장은
    // ADR 원문 그대로여야 한다 — 코어에서 가져온다.
    expect(
      screen.getByTestId('ade-card-durability-session|session-running'),
    ).toHaveTextContent(new RegExp(durabilityBadge('persistent')));
    // 랩탑 위의 호스트는 그렇지 않다.
    expect(
      screen.getByTestId('ade-card-durability-session|session-orphaned'),
    ).toHaveTextContent(new RegExp(durabilityBadge('device_bound')));
    // 턴에는 호스트가 없으므로 **아무 배지도 없다** — 「해당 없음」과 「모른다」는
    // 다른 사실이고, 화면에서 둘을 구별하는 방법은 앞의 것을 말하지 않는 것이다.
    expect(
      screen.queryByTestId(
        `ade-card-durability-run|${RUN_KIM.toLowerCase()}|${GENERAL.toLowerCase()}`,
      ),
    ).toBeNull();
  });

  it('등록기에 없는 호스트의 세션은 「실행 위치 확인 필요」를 경고 톤으로 세운다', async () => {
    // 호스트 등록기는 워크스페이스가 **지금 아는** 기계의 목록이고 세션 원장은
    // 있었던 일의 기록이라, 기계가 등록에서 빠진 뒤에도 그 기계의 세션 행은 남는다.
    // 그 카드에 대해 화면이 할 수 있는 정직한 말은 「모른다」 하나뿐이고, 그것은
    // 침묵이 아니라 **경고**여야 한다 — 사람이 랩탑을 덮을지 정하는 자리다.
    installFetch({
      workSessions: () =>
        jsonResponse(200, {
          workSessions: [
            ...WORK_SESSIONS,
            {
              ...WORK_SESSIONS[1],
              id: 'SESSION-HOST-GONE',
              hostId: 'HOST-RETIRED',
              label: '스테이징 마이그레이션',
            },
          ],
        }),
    });
    await openConversation();
    await openBothTurns();
    await waitFor(() => expect(screen.getByTestId('ade-summary')).toBeTruthy());
    fireEvent.press(screen.getByTestId('ade-summary'));
    await waitFor(() => expect(screen.getByTestId('ade-card-list')).toBeTruthy());

    await waitFor(() =>
      expect(
        screen.getByTestId('ade-card-durability-session|session-host-gone'),
      ).toBeTruthy(),
    );
    const badge = screen.getByTestId(
      'ade-card-durability-session|session-host-gone',
    );
    expect(badge).toHaveTextContent(new RegExp(durabilityBadge('unknown')));
    // 「모른다」는 안심시키는 두 문장과 **다른 색**으로 선다. 셋이 같은 잉크면 이
    // 줄은 세 등급 모두에 대해 같은 무게로 읽히고, 그러면 경고가 경고가 아니다.
    expect(flatStyle(badge.props.style).color).toBe(color.warn);
    expect(
      flatStyle(
        screen.getByTestId('ade-card-durability-session|session-orphaned').props
          .style,
      ).color,
    ).not.toBe(color.warn);
  });

  it('경과는 3등 잉크에 두지 않고, 매 초 자리를 옮기지 않는다', async () => {
    installFetch();
    await openConversation();
    await openBothTurns();
    await waitFor(() => expect(screen.getByTestId('ade-summary')).toBeTruthy());
    fireEvent.press(screen.getByTestId('ade-summary'));
    await waitFor(() => expect(screen.getByTestId('ade-card-list')).toBeTruthy());

    const elapsed = flatStyle(
      screen.getByTestId('ade-card-elapsed-session|session-running').props.style,
    );
    // 이 숫자는 목록의 정렬 근거이자 사람이 「너무 오래 붙들려 있다」를 정하는
    // 재료다 — 장식이 아니므로 3등 잉크에 두지 않는다. `textFaint` 는 카드
    // surface(#201f24) 위에서 3.238:1 로 본문 AA 미달이기도 하다 (design-review H-1).
    expect(elapsed.color).toBe(color.textMuted);
    expect(elapsed.color).not.toBe(color.textFaint);
    // 1Hz 로 다시 그려지는 숫자다. 비례폭이면 `9s`->`10s` 처럼 자릿수가 바뀔 때마다
    // 옆의 칩과 제목이 매 초 흔들린다 (design-review M-2).
    expect(elapsed.fontVariant).toEqual(['tabular-nums']);
  });

  it('카드를 누르면 그 카드의 방이 열리고, 목록은 물러난다', async () => {
    installFetch();
    await openConversation();
    await openBothTurns();
    await waitFor(() => expect(screen.getByTestId('ade-summary')).toBeTruthy());
    fireEvent.press(screen.getByTestId('ade-summary'));
    await waitFor(() => expect(screen.getByTestId('ade-card-list')).toBeTruthy());

    // #build 에 있는 세션. 지금 열려 있는 방은 #general 이다.
    expect(screen.getByTestId('conversation-title')).toHaveTextContent(/general/);
    fireEvent.press(screen.getByTestId('ade-card-session|session-orphaned'));

    await waitFor(() =>
      expect(screen.getByTestId('conversation-title')).toHaveTextContent(/build/),
    );
    // 목록은 남아 있지 않다. 겹쳐 서면 방금 누른 카드가 어디 갔는지 모른다.
    expect(screen.queryByTestId('ade-card-list')).toBeNull();
  });

  it('원장을 못 읽으면 목록이 그 사실을 말하고 다시 시도를 준다 — 턴은 그대로 센다', async () => {
    installFetch({
      workSessions: () => jsonResponse(500, {error: {message: 'boom'}}),
    });
    await openConversation();
    await openBothTurns();

    // 세션 반쪽이 없어도 턴 반쪽은 진짜다. 0 으로 세는 것이 아니라 모르는 것이고,
    // 요약 줄은 아는 것만 센다.
    await waitFor(() => expect(screen.getByTestId('ade-summary')).toBeTruthy());
    expect(screen.getByTestId('ade-summary-text')).toHaveTextContent(
      /실행 중인 작업 1개 · 대기 1/,
    );

    fireEvent.press(screen.getByTestId('ade-summary'));
    await waitFor(() =>
      expect(screen.getByTestId('ade-sessions-error')).toBeTruthy(),
    );
    expect(screen.getByTestId('ade-sessions-error')).toHaveTextContent(
      /작업 세션 목록을 불러오지 못했습니다/,
    );
    // 서버가 뱉은 말을 그대로 화면에 붙이지 않는다.
    expect(screen.queryByText(/boom/)).toBeNull();
    expect(screen.getByTestId('ade-sessions-error-retry')).toBeTruthy();
  });

  it('열어 둔 채 마지막 작업이 끝나면 목록은 남고 빈 문장이 선다', async () => {
    installFetch({workSessions: () => jsonResponse(200, {workSessions: []})});
    await openConversation();
    await openBothTurns();
    await waitFor(() => expect(screen.getByTestId('ade-summary')).toBeTruthy());
    fireEvent.press(screen.getByTestId('ade-summary'));
    await waitFor(() => expect(screen.getByTestId('ade-card-list')).toBeTruthy());

    // 두 턴이 끝난다.
    await deliver(
      GENERAL,
      KIM_AGENT,
      statusFrame(GENERAL, KIM_AGENT, RUN_KIM, {
        phase: 'completed',
        run_status: 'succeeded',
      }),
      20,
    );
    await deliver(
      BUILD,
      HERMES_AGENT,
      statusFrame(BUILD, HERMES_AGENT, RUN_HERMES, {
        phase: 'completed',
        run_status: 'succeeded',
      }),
      20,
    );

    await waitFor(() =>
      expect(screen.getByTestId('ade-panel-empty')).toBeTruthy(),
    );
    expect(screen.getByTestId('ade-panel-empty')).toHaveTextContent(
      new RegExp(ADE_DRAWER_EMPTY_HEADLINE.replace(/[.]/g, '\\.')),
    );
    // 화면은 사람 손 밑에서 사라지지 않는다.
    expect(screen.getByTestId('ade-panel-title')).toBeTruthy();
  });
});

describe('요청 예산', () => {
  it('호스트 등록기는 목록을 열기 전까지 부르지 않는다', async () => {
    const log = installFetch();
    await openConversation();
    await openBothTurns();
    await waitFor(() => expect(screen.getByTestId('ade-summary')).toBeTruthy());

    // 요약 줄은 생존성을 그리지 않는다. 대화를 열 때마다 아무도 안 볼 등록기를
    // 한 번 더 부르는 것은 폰에서 라디오다.
    expect(log.callsTo('/work-hosts')).toBe(0);
    expect(log.callsTo('/work-sessions')).toBeGreaterThan(0);

    fireEvent.press(screen.getByTestId('ade-summary'));
    await waitFor(() => expect(log.callsTo('/work-hosts')).toBe(1));
  });
});

// =============================================================================
// 발원 대화 앵커 (#1193)
//
// 이 화면의 머리말에는 「재료가 없어서 방까지만 데려간다」가 적혀 있었다. 재료는
// 처음부터 원장에 있었고(`work_session.root_message_id`), 착지 기계도 이미
// `seq: null` 을 받는다. 아래 셋이 그 연결을 각각 다른 각도에서 잰다.
// =============================================================================

describe('「대화로」 — 그 작업을 낳은 줄까지', () => {
  /** 지금 화면에 걸려 있는 점프. 목록이 아니라 **타임라인이 받은 것**을 읽는다. */
  function jumpTargetOf(): {messageId: string; seq: number | null} | null {
    const nodes = screen.UNSAFE_root.findAll(
      (node: {props?: Record<string, unknown>}) =>
        node.props?.jumpTarget !== undefined,
    );
    const found = nodes[0]?.props?.jumpTarget;
    return (found as {messageId: string; seq: number | null}) ?? null;
  }

  it('RED PROOF — 카드가 원장의 발원 메시지로 점프를 건다', async () => {
    installFetch();
    await openConversation();
    await openBothTurns();
    await waitFor(() => expect(screen.getByTestId('ade-summary')).toBeTruthy());
    fireEvent.press(screen.getByTestId('ade-summary'));
    await waitFor(() => expect(screen.getByTestId('ade-card-list')).toBeTruthy());

    // 기대값을 손으로 적지 않는다. 원장 픽스처가 정본이고, 화면이 그 행의
    // `rootMessageId` 를 그대로 나르는지를 본다 — 앵커 칸이 사라지거나 다른
    // 필드를 싣기 시작하면 이 단정이 먼저 깨진다.
    const ledgerRow = WORK_SESSIONS.find(row => row.id === 'SESSION-RUNNING');
    expect(ledgerRow?.channelId).toBe(GENERAL);

    fireEvent.press(screen.getByTestId('ade-card-anchor-session|session-running'));
    // 목록은 물러난다. 착지한 줄 위에 카드 목록이 떠 있으면 사람은 자기가
    // 도착했다는 사실을 못 본다.
    await waitFor(() => expect(screen.queryByTestId('ade-card-list')).toBeNull());

    await waitFor(() => expect(jumpTargetOf()).not.toBeNull());
    expect(jumpTargetOf()?.messageId).toBe(ledgerRow?.rootMessageId);
    // 세션 원장은 순서값을 나르지 않는다. 없는 seq 를 지어내지 않는다.
    expect(jumpTargetOf()?.seq).toBeNull();
  });

  it('못 찾으면 **그 작업을 시작한 메시지**를 못 찾았다고 말한다', async () => {
    // 이 하네스의 타임라인은 비어 있다. 그래서 점프는 반드시 빈손으로 돌아오고,
    // 그때 화면이 무슨 낱말을 쓰는지가 이 단정의 대상이다: 「대화로」를 누른
    // 사람은 인용을 누른 적이 없다.
    installFetch();
    await openConversation();
    await openBothTurns();
    await waitFor(() => expect(screen.getByTestId('ade-summary')).toBeTruthy());
    fireEvent.press(screen.getByTestId('ade-summary'));
    await waitFor(() => expect(screen.getByTestId('ade-card-list')).toBeTruthy());
    fireEvent.press(screen.getByTestId('ade-card-anchor-session|session-running'));

    await waitFor(() =>
      expect(screen.getByTestId('jump-missed')).toBeTruthy(),
    );
    const notice = jumpMissedNotice('unknown', 'session');
    expect(screen.getByTestId('jump-missed')).toHaveTextContent(
      new RegExp(notice.headline),
    );
    expect(screen.getByTestId('jump-missed')).not.toHaveTextContent(
      /인용한 원본/,
    );
  });

  // 죽은 버튼 금지. 턴에는 원장 행이 없으므로 발원 메시지도 없다.
  it('턴 카드에는 그 동사가 아예 서지 않는다', async () => {
    installFetch();
    await openConversation();
    await openBothTurns();
    await waitFor(() => expect(screen.getByTestId('ade-summary')).toBeTruthy());
    fireEvent.press(screen.getByTestId('ade-summary'));
    await waitFor(() => expect(screen.getByTestId('ade-card-list')).toBeTruthy());

    const withPrefix = (prefix: string): string[] =>
      screen.UNSAFE_root
        .findAll((node: {props?: {testID?: unknown}}) =>
          String(node.props?.testID ?? '').startsWith(prefix),
        )
        .map((node: {props?: {testID?: unknown}}) => String(node.props?.testID));

    // 컨트롤은 세션 카드 셋(running · orphaned · idle)에만 선다.
    expect(new Set(withPrefix('ade-card-anchor-session|')).size).toBe(3);
    // 턴 둘에는 컨트롤이 없다. 있는 것은 **자리**뿐이다 (리뷰 H1) — 목록의
    // 오른쪽 끝이 카드 종류에 따라 흔들리지 않게.
    expect(withPrefix('ade-card-anchor-run|')).toHaveLength(0);
    const ghosts = withPrefix('ade-card-anchor-ghost-');
    expect(new Set(ghosts).size).toBe(2);
    expect(ghosts.every((id: string) => id.includes('ghost-run|'))).toBe(true);
  });

  // 유령은 **자리**이지 컨트롤이 아니다 (리뷰 H1). 누를 수도 없고 낭독에도 없다.
  it('예약된 칸은 버튼이 아니다 — 자리만 잡는다', async () => {
    installFetch();
    await openConversation();
    await openBothTurns();
    await waitFor(() => expect(screen.getByTestId('ade-summary')).toBeTruthy());
    fireEvent.press(screen.getByTestId('ade-summary'));
    await waitFor(() => expect(screen.getByTestId('ade-card-list')).toBeTruthy());

    const ghost = screen.UNSAFE_root.findAll((node: {props?: {testID?: unknown}}) =>
      String(node.props?.testID ?? '').startsWith('ade-card-anchor-ghost-'),
    )[0] as unknown as {props: Record<string, unknown>};
    expect(ghost.props.accessibilityRole).toBeUndefined();
    expect(ghost.props.onPress).toBeUndefined();
    expect(ghost.props.accessibilityElementsHidden).toBe(true);
    // 폭은 컨트롤과 같은 규칙에서 온다: 같은 스타일, 같은 글자.
    expect(flatStyle(ghost.props.style).opacity).toBe(0);
  });

  // 리뷰 N-a — 같은 컨트롤의 경계를 두 클라이언트가 다르게 그리지 않는다.
  it('컨트롤 경계가 3:1 을 넘는 토큰이다 — hairline 토큰이 아니라', async () => {
    installFetch();
    await openConversation();
    await openBothTurns();
    await waitFor(() => expect(screen.getByTestId('ade-summary')).toBeTruthy());
    fireEvent.press(screen.getByTestId('ade-summary'));
    await waitFor(() => expect(screen.getByTestId('ade-card-list')).toBeTruthy());

    const anchor = screen.getByTestId('ade-card-anchor-session|session-running');
    const style = flatStyle(anchor.props.style);
    // 웹의 `--line-strong` 과 **바이트로 같은** 값이다(`paletteContrast` 가 그
    // 짝을 잰다). `border` 는 카드 위에서 1.3~1.4:1 이라 컨트롤의 가장자리가
    // 되지 못한다 — 같은 파일의 팔레트 게이트가 그 사실을 따로 잠근다.
    expect(style.borderLeftColor).toBe(color.textFaint);
    expect(style.borderLeftColor).not.toBe(color.border);
  });

  it('다른 방의 카드는 그 방을 열고 나서 착지한다', async () => {
    installFetch();
    await openConversation(GENERAL);
    await openBothTurns();
    await waitFor(() => expect(screen.getByTestId('ade-summary')).toBeTruthy());
    fireEvent.press(screen.getByTestId('ade-summary'));
    await waitFor(() => expect(screen.getByTestId('ade-card-list')).toBeTruthy());

    // 이 카드는 build 채널의 것이다 — 지금 열려 있는 방이 아니다.
    fireEvent.press(screen.getByTestId('ade-card-anchor-session|session-orphaned'));
    await waitFor(() =>
      expect(screen.getByTestId('conversation-title')).toHaveTextContent(/build/),
    );
    await waitFor(() =>
      expect(jumpTargetOf()?.messageId).toBe(
        WORK_SESSIONS.find(row => row.id === 'SESSION-ORPHANED')?.rootMessageId,
      ),
    );
  });
});
