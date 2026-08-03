import type {Member} from '@momo/core/lib/api';
import {
  IDLE_CUTOFF_MS,
  type AgentWorkingSignal,
} from '@momo/core/features/agents/workingSignal';
import {TURN_STALE_SENTENCE} from '@momo/core/features/agents/turnCopy';
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

import {
  agentTurnsForMember,
  agentTurnsInChannel,
  agentWorkingSnapshot,
  hasChannelTurn,
  markAgentWorking,
  resetAgentWorking,
  sweepAgentWorking,
  ZOMBIE_CLEAR_MS,
} from '../src/features/agents/workingSignal';
import {color} from '../src/design/tokens';
import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// 폰의 「작업 중」 — 실시간 턴 신호 (goal RN-T2).
//
// ## 무엇을 가짜로 두는가
//
// 두 가지뿐이다: `fetch`가 무엇을 답했는가, 그리고 소켓이 무엇을 실어 왔는가.
// 그 아래는 전부 진짜다 — core의 `agentRail`(어떤 쌍을 볼지·프레임이 무엇을
// 뜻하는지·언제 런이 끝났는지·동시 런을 어떻게 합치는지), core의 `workingSignal`
// 규칙(90초 TTL·상태 판정), core의 `turnCopy`(화면에 나가는 모든 낱말), 이
// 클라이언트의 스토어와 레일과 화면.
//
// 특히 **문구를 mock하지 않는 것**이 중요하다. "승인 대기를 작업 중이라고 하지
// 않는다"는 단정이 mock된 문자열을 향하면 아무것도 지키지 못한다. 지켜야 하는
// 것은 **화면에 그 글자가 없다**이다.
//
// ## 타이밍 (#839의 교훈)
//
// 목이 같은 tick에 답하면 "아직 아무 배지도 없다"를 단언해도 헛초록이다. 그래서
// 프레임은 구독이 붙은 tick에 오지 않는다: `deliver()`가 실제로 기다렸다가
// 내보내고, 두 프레임 사이에도 서로 다른 지연을 둔다(#839의 catalog/detail 160ms
// 편차와 같은 이유 — 같은 지연은 순서를 증명하지 못한다). 프레임이 오기 전 상태를
// 먼저 확인하고, 그 다음에 온 뒤를 확인한다.
//
// ## 시계
//
// TTL과 zombie 정리는 **스토어에 직접** 건다. 그 둘은 `nowMs`를 인자로 받는
// 함수이므로 90초/120초를 정확히 만들 수 있고, 그러기 위해 렌더 트리의 시계를
// 가짜로 돌릴 이유가 없다 — 가짜 타이머 위에 react-query를 얹으면 무엇이 언제
// 풀렸는지가 오히려 흐려진다. 화면 쪽은 실제 시계로, 프레임이 만든 것만 본다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const KIM_AGENT = 'cccccccc-1111-4111-8111-cccccccccccc';
const HERMES = 'dddddddd-1111-4111-8111-dddddddddddd';
const GENERAL = 'ch-general';
const SECRET = 'ch-secret';
const RUN = 'A1111111-1111-4111-8111-A11111111111';
const BASE = 'https://api.example.com';

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

// ---- 스토어 단위 -------------------------------------------------------------

function signal(over: Partial<AgentWorkingSignal> = {}): AgentWorkingSignal {
  return {
    memberId: KIM_AGENT,
    channelId: GENERAL,
    state: 'working',
    source: 'status',
    runId: RUN,
    startedAtMs: 1_000,
    headlines: [],
    lastActivityAtMs: 1_000,
    ...over,
  };
}

const NOW = 10_000_000;

/** RN style props arrive as a value or an (possibly nested) array. */
function flatStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>(
      (acc, entry) => ({...acc, ...flatStyle(entry)}),
      {},
    );
  }
  return (style as Record<string, unknown> | null | undefined) ?? {};
}

describe('신호 스토어 — 규칙은 core의 것이고 시계만 여기 있다', () => {
  afterEach(() => resetAgentWorking());

  it('TTL: 90초를 넘긴 신호는 스토어에 남아 있어도 표면에 나가지 않는다', () => {
    // 스토어에서 지우는 것과 화면에서 빼는 것은 다른 시각에 일어난다. 90초와
    // 120초 사이의 이 구간이 그 간극이고, 여기서 표면이 "지금 일하는 중"이라고
    // 말하면 그것이 이 모듈이 막으려는 거짓말이다.
    markAgentWorking(signal({lastActivityAtMs: NOW - IDLE_CUTOFF_MS - 1}));
    expect(agentWorkingSnapshot().size).toBe(1);
    expect(agentTurnsInChannel(agentWorkingSnapshot(), GENERAL, NOW)).toEqual([]);
    expect(agentTurnsForMember(agentWorkingSnapshot(), KIM_AGENT, NOW)).toEqual([]);
    // 경계 바로 안쪽은 살아 있다 — 90초는 "넘긴" 것이 아니다.
    markAgentWorking(signal({lastActivityAtMs: NOW - IDLE_CUTOFF_MS}));
    expect(agentTurnsInChannel(agentWorkingSnapshot(), GENERAL, NOW)).toHaveLength(1);
  });

  it('zombie: 120초를 넘기면 스토어에서 지운다 (경계값은 남긴다)', () => {
    markAgentWorking(signal({lastActivityAtMs: NOW - ZOMBIE_CLEAR_MS - 1}));
    markAgentWorking(
      signal({memberId: HERMES, lastActivityAtMs: NOW - ZOMBIE_CLEAR_MS}),
    );
    sweepAgentWorking(NOW);
    const keys = [...agentWorkingSnapshot().keys()];
    expect(keys).toEqual([`${GENERAL}|${HERMES.toLowerCase()}`]);
  });

  it('hasChannelTurn 은 시계를 보지 않는다 — 시계를 켤지 정하는 쪽이므로', () => {
    markAgentWorking(signal({lastActivityAtMs: 0}));
    // 이미 만료된 신호라도 "이 채널에 항목이 있는가"는 참이다. 이 함수의 답으로
    // 1Hz 시계를 켜고, 만료 여부는 그 시계가 굴러간 뒤 렌더 시점에 거른다.
    expect(hasChannelTurn(agentWorkingSnapshot(), GENERAL)).toBe(true);
    expect(hasChannelTurn(agentWorkingSnapshot(), SECRET)).toBe(false);
  });

  it('한 에이전트를 채널 너머로 모은다 — 에이전트 탭은 채널 목록이 아니다', () => {
    markAgentWorking(signal({channelId: GENERAL, lastActivityAtMs: NOW, startedAtMs: NOW - 5_000}));
    markAgentWorking(signal({channelId: SECRET, lastActivityAtMs: NOW, startedAtMs: NOW - 60_000}));
    markAgentWorking(signal({channelId: GENERAL, memberId: HERMES, lastActivityAtMs: NOW}));

    const mine = agentTurnsForMember(agentWorkingSnapshot(), KIM_AGENT, NOW);
    // 두 채널, 오래된 턴이 먼저. 헤르메스는 섞이지 않는다.
    expect(mine.map(turn => turn.channelId)).toEqual([SECRET, GENERAL]);
    expect(agentTurnsForMember(agentWorkingSnapshot(), HERMES, NOW)).toHaveLength(1);
  });

  it('대소문자가 다른 id 로도 같은 턴이다 — 와이어가 섞어 보내기 때문', () => {
    // 측정된 사실: `run_id`는 Swift `uuidString`이라 대문자이고 `channel_id`는
    // 소문자로 온다. 키를 접지 않으면 같은 턴이 두 줄이 된다.
    markAgentWorking(signal({channelId: GENERAL.toUpperCase(), memberId: KIM_AGENT.toUpperCase(), lastActivityAtMs: NOW}));
    markAgentWorking(signal({lastActivityAtMs: NOW}));
    expect(agentWorkingSnapshot().size).toBe(1);
  });
});

// ---- 화면 + 와이어 단위 -------------------------------------------------------

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
  rosterMember({
    id: HERMES,
    kind: 'agent',
    displayName: '헤르메스',
    handle: 'hermes',
  }),
];

const CHANNELS = [
  {id: GENERAL, workspaceId: WS, kind: 'public', name: 'general', muted: false},
];

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function installFetch(): jest.Mock {
  const mock = jest.fn(async (url: string) => {
    if (url.includes('/profile')) {
      return jsonResponse(403, {error: {message: 'agent owner required'}});
    }
    if (url.includes('/work-sessions')) return jsonResponse(200, {workSessions: []});
    if (url.includes('/work-hosts')) return jsonResponse(200, {workHosts: []});
    if (url.includes('/allowed-models')) {
      return jsonResponse(200, {allowedAgentModels: []});
    }
    if (url.includes('/channels') && !url.includes('/messages')) {
      return jsonResponse(200, {channels: CHANNELS});
    }
    if (url.includes('/roster')) return jsonResponse(200, {members: ROSTER});
    if (url.includes('/read-state')) return jsonResponse(200, {read_states: []});
    if (url.includes('/messages')) return jsonResponse(200, {messages: []});
    if (url.includes('/reactions')) return jsonResponse(200, {});
    throw new Error(`unrouted request: ${url}`);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

interface FakeSubscription {
  channel: string;
  options: {recoverable: boolean; positioned: boolean};
  unsubscribeCount: number;
  __emit: (event: string, ctx: unknown) => void;
  __subscribed: (options?: {recovered?: boolean; publications?: unknown[]}) => void;
}

interface FakeClient {
  getSubscription: (name: string) => FakeSubscription | null;
  __emit: (event: string, ctx: unknown) => void;
}

const centrifugeMock = jest.requireMock('centrifuge') as {
  __clients: FakeClient[];
  __reset: () => void;
};

/** The socket the signed-in tree actually built. */
function client(): FakeClient {
  const clients = centrifugeMock.__clients;
  return clients[clients.length - 1];
}

const AGENT_CHANNEL = centrifugoAgentChannelName(WS, GENERAL, KIM_AGENT);

function agentSub(): FakeSubscription | null {
  return client()?.getSubscription(AGENT_CHANNEL) ?? null;
}

function statusFrame(over: Record<string, unknown> = {}) {
  return {
    type: 'agent.status',
    v: 1,
    ts: Date.now(),
    payload: {
      run_id: RUN,
      agent_member_id: KIM_AGENT,
      channel_id: GENERAL,
      phase: 'queued',
      run_status: 'queued',
      ...over,
    },
  };
}

function partialFrame(over: Record<string, unknown> = {}) {
  return {
    type: 'agent.partial',
    v: 1,
    ts: Date.now(),
    payload: {run_id: RUN, channel_id: GENERAL, ...over},
  };
}

/**
 * Deliver a publication LATER, never on the tick that asked for it.
 *
 * #839: a mock that answers synchronously turns "there is no badge yet" into a
 * statement about nothing. The delay is real (real timers), and callers pass
 * DIFFERENT delays for consecutive frames so that an assertion about order is
 * about order and not about two things landing in one flush.
 */
async function deliver(data: unknown, delayMs: number): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    agentSub()?.__emit('publication', {data});
  });
}

/**
 * The subscription comes back RECOVERED and flushes a batch, exactly as
 * centrifuge-js does: the `subscribed` event, then every recovered publication
 * synchronously behind it. Arrives on its own tick like everything else here.
 */
async function replay(publications: unknown[], delayMs: number): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    agentSub()?.__subscribed({recovered: true, publications});
  });
}

/**
 * Cut the socket the way a real drop does.
 *
 * `RealtimeProvider` has already seen `connected` by now, so its own rule ("once
 * we have been connected, not being connected is being disconnected") turns this
 * into `disconnected`. The background POLICY is untouched — the app is still in
 * front and still wants a socket — so the agent rail stays subscribed and the
 * store keeps what it was told. That separation is the point of the two flags.
 */
async function cutSocket(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 15));
    client().__emit('disconnected', {});
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

async function openAgentsTab() {
  renderShell();
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
  fireEvent.press(screen.getByTestId('tab-agents'));
  await waitFor(() => expect(screen.getByTestId('agents-list')).toBeTruthy());
  await waitFor(() => expect(agentSub()).toBeTruthy());
}

const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;

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

describe('와이어 — 두 클라이언트가 같은 프레임을 읽는다', () => {
  it('멤버십 쌍마다 agent:ws<WS>.<CH>.<AGENT> 를 구독한다', async () => {
    await openAgentsTab();
    // 이름은 core가 만든다. 여기서 확인하는 것은 **어느 쌍을 구독했는가**이다:
    // 김인턴은 #general의 활성 에이전트 멤버이고, 헤르메스는 어느 채널에도 없다.
    expect(agentSub()).toBeTruthy();
    expect(
      client().getSubscription(centrifugoAgentChannelName(WS, GENERAL, HERMES)),
    ).toBeNull();
  });

  it('회복(recovery) 배치는 끝난 턴을 되살리지 못한다', async () => {
    await openAgentsTab();
    const row = () => screen.getByTestId(`agent-row-${KIM_AGENT}`);
    expect(row()).not.toHaveTextContent(/작업 중/);

    // 잠들었다 깬 폰이 만나는 것: `subscribed`가 recovered로 돌아오고, 이미
    // 끝난 턴의 프레임들이 그 뒤로 동기적으로 쏟아진다. 하나라도 접히면
    // 화면에 죽은 턴이 시계를 달고 되살아난다.
    await replay(
      [
        statusFrame({phase: 'streaming', run_status: 'running'}),
        partialFrame({text: '빌드 확인 중'}),
      ],
      30,
    );
    expect(row()).not.toHaveTextContent(/작업 중/);
  });

  it('회복 배치의 종료 프레임은 통과한다 — 그렇지 않으면 90초 동안 거짓 「작업 중」', async () => {
    // 2R H1. 백그라운드 유예가 끝나면 소켓이 내려가므로, 그 사이에 끝난 턴의
    // 종료 프레임은 **회복 배치에만** 존재한다. 그것마저 버리면 복귀한 폰이
    // 이미 멈춘 에이전트를 두고 최대 90초(TTL) 동안 「작업 중」이라고 말한다.
    //
    // 서버가 그 프레임을 싣는다는 것은 코드에서 확인했다:
    // `workers/AgentWorker/.../WorkerService.swift:578`이 `.done`을 이 채널에
    // publish하고 `clientRunStatus`가 `succeeded`로, `agentPhase`가 `done`으로
    // 투영한다(:2584-2604). `infra/centrifugo.json`의 `agent` 네임스페이스는
    // `history_size: 100 · history_ttl: 24h · force_recovery: true`라 그 프레임은
    // 회복 배치에 남아 있다.
    await openAgentsTab();
    const row = () => screen.getByTestId(`agent-row-${KIM_AGENT}`);

    await deliver(statusFrame(), 20);
    await deliver(statusFrame({phase: 'streaming', run_status: 'running'}), 45);
    await waitFor(() => expect(row()).toHaveTextContent(/작업 중/));

    // 자리를 비운 사이에 턴이 끝났다. 복귀하면 회복 배치가 그 사실을 들고 온다 —
    // 살아 있음을 주장하는 프레임들과 함께. 앞의 것들은 여전히 버려지고 마지막
    // 종료 프레임만 통과한다.
    await replay(
      [
        partialFrame({text: '마지막 줄'}),
        statusFrame({phase: 'streaming', run_status: 'running'}),
        statusFrame({phase: 'done', run_status: 'succeeded'}),
      ],
      30,
    );

    await waitFor(() =>
      expect(screen.queryByTestId(`agent-turn-${KIM_AGENT}`)).toBeNull(),
    );
    expect(row()).not.toHaveTextContent(/작업 중/);
  });

  it('회복 배치의 종료 프레임은 없던 턴을 만들지 못한다', async () => {
    // 통과시킨 구멍이 켜는 쪽으로는 절대 열리지 않는다는 것. `applyStatus`의
    // 종료 분기는 delete만 하고, 없으면 같은 map을 그대로 돌려준다.
    await openAgentsTab();
    await replay([statusFrame({phase: 'done', run_status: 'succeeded'})], 25);
    expect(screen.queryByTestId(`agent-turn-${KIM_AGENT}`)).toBeNull();
    expect(screen.getByTestId(`agent-row-${KIM_AGENT}`)).not.toHaveTextContent(
      /작업 중|승인 대기/,
    );
  });
});

describe('에이전트 탭 — 열린 턴을 말한다', () => {
  it('프레임이 오기 전에는 아무 배지도 없고, running 프레임이 「작업 중」을 켠다', async () => {
    await openAgentsTab();
    const row = () => screen.getByTestId(`agent-row-${KIM_AGENT}`);

    // 구독은 붙었지만 프레임은 아직 오지 않았다. 목이 같은 tick에 답했다면 이
    // 단정은 아무것도 증명하지 못한다 — `deliver`가 실제로 기다리는 이유.
    expect(screen.queryByTestId(`agent-turn-${KIM_AGENT}`)).toBeNull();
    expect(row()).not.toHaveTextContent(/작업 중/);
    expect(row()).not.toHaveTextContent(/승인 대기/);

    // `queued`는 이미 열린 턴이다 — 그리고 시작 시각을 아는 유일한 프레임이다.
    await deliver(statusFrame(), 20);
    await waitFor(() => expect(row()).toHaveTextContent(/작업 중/));

    // ↑ 이 중간 단정이 목 편차가 사는 자리다. 두 프레임이 한 flush에 들어왔다면
    // 프레임 사이의 상태는 애초에 관찰할 수 없고, 아래 단정은 두 번째 프레임이
    // 만든 결과를 첫 번째의 것으로 착각한 채 초록이 된다 (#839).
    await deliver(statusFrame({phase: 'streaming', run_status: 'running'}), 45);

    await waitFor(() =>
      expect(screen.getByTestId(`agent-turn-${KIM_AGENT}`)).toBeTruthy(),
    );
    expect(row()).toHaveTextContent(/작업 중/);
    // 세션 원장은 비어 있다. 「작업 세션 N개 실행 중」은 다른 사실이고, 이 배지가
    // 그것을 대신 말하지 않는다.
    expect(row()).not.toHaveTextContent(/작업 세션/);
  });

  it('RED PROOF — awaiting_approval 은 절대 「작업 중」으로 렌더되지 않는다', async () => {
    await openAgentsTab();
    const row = () => screen.getByTestId(`agent-row-${KIM_AGENT}`);

    await deliver(statusFrame(), 20);
    await deliver(statusFrame({phase: 'streaming', run_status: 'running'}), 45);
    await waitFor(() => expect(row()).toHaveTextContent(/작업 중/));

    // momowebqa의 @kim-intern은 **모든 턴을** 이 상태로 끝낸다(측정됨). 런 행은
    // 아직 열려 있으므로 배지는 사라지지 않는데, 다음 수는 사람의 것이다. 둘을
    // 같이 다루는 표시는 사람더러 에이전트를 기다리라고 말하고, 에이전트는 그
    // 사람을 기다린다.
    await deliver(
      statusFrame({phase: 'thinking', run_status: 'awaiting_approval'}),
      35,
    );

    await waitFor(() => expect(row()).toHaveTextContent(/승인 대기/));
    expect(row()).not.toHaveTextContent(/작업 중/);
  });

  it('partial 은 승인 대기에 멈춘 런을 「작업 중」으로 되돌리지 못한다', async () => {
    await openAgentsTab();
    const row = () => screen.getByTestId(`agent-row-${KIM_AGENT}`);

    await deliver(statusFrame(), 20);
    await deliver(
      statusFrame({phase: 'thinking', run_status: 'awaiting_approval'}),
      40,
    );
    await waitFor(() => expect(row()).toHaveTextContent(/승인 대기/));

    // 문서화된 payload 모양: 텍스트가 하나도 없는 tool_call 프레임. 상태는
    // `run_status`만 정하고 그것은 `agent.status`에만 실린다 — partial 하나가
    // 승인 대기를 작업 중으로 끌어내면 두 표면이 다시 "기다리세요"라고 말한다.
    await deliver(partialFrame({tool_call_id: 't1', tool_call_name: 'read'}), 25);
    expect(row()).toHaveTextContent(/승인 대기/);
    expect(row()).not.toHaveTextContent(/작업 중/);
  });

  it('종료 프레임이 배지를 끈다', async () => {
    await openAgentsTab();
    const row = () => screen.getByTestId(`agent-row-${KIM_AGENT}`);

    await deliver(statusFrame(), 20);
    await deliver(statusFrame({phase: 'streaming', run_status: 'running'}), 45);
    await waitFor(() => expect(row()).toHaveTextContent(/작업 중/));

    await deliver(statusFrame({phase: 'done', run_status: 'succeeded'}), 30);
    await waitFor(() =>
      expect(screen.queryByTestId(`agent-turn-${KIM_AGENT}`)).toBeNull(),
    );
    expect(row()).not.toHaveTextContent(/작업 중/);
  });

  it('이미 TTL을 넘긴 채 도착한 프레임은 배지를 켜지 못한다', async () => {
    await openAgentsTab();
    // 서버 시계로 이미 90초 넘은 프레임은 무엇도 살아 있음을 증명하지 못한다.
    // 회복 게이트 뒤의 두 번째 방어선이고, 실패 방향이 의도적이다: 아무것도 안
    // 보이는 쪽이지 거짓을 보이는 쪽이 아니다.
    await deliver(
      {
        type: 'agent.status',
        v: 1,
        ts: Date.now() - IDLE_CUTOFF_MS - 5_000,
        payload: {
          run_id: RUN,
          agent_member_id: KIM_AGENT,
          channel_id: GENERAL,
          phase: 'streaming',
          run_status: 'running',
        },
      },
      25,
    );
    expect(screen.queryByTestId(`agent-turn-${KIM_AGENT}`)).toBeNull();
  });

  it('한 행에 두 사실이 나란히 서고, 좁아지면 이름이 먼저 줄어든다', async () => {
    // 2R M5. 실제 텍스트 폭은 Jest에서 잴 수 없다(레이아웃 엔진이 없다). 잴 수
    // 있는 것은 **무엇이 먼저 양보하도록 만들어져 있는가**이고, 그것이 이 행의
    // 실제 설계 결정이다: 두 배지는 `flexShrink`를 갖지 않고, 이름/핸들만 갖는다.
    // 즉 좁아졌을 때 사라지는 것은 상태 낱말이 아니라 이름의 꼬리다.
    installFetch();
    await openAgentsTab();
    await deliver(statusFrame(), 20);
    await deliver(statusFrame({phase: 'streaming', run_status: 'running'}), 45);

    const row = screen.getByTestId(`agent-row-${KIM_AGENT}`);
    await waitFor(() => expect(row).toHaveTextContent(/작업 중/));
    // 이름·핸들·상태 낱말이 모두 같은 행에 있다.
    expect(row).toHaveTextContent(/김인턴/);
    expect(row).toHaveTextContent(/@kim-intern/);

    const title = screen.getByText('김인턴');
    expect(title.props.numberOfLines).toBe(1);
    expect(title.props.ellipsizeMode).toBe('tail');
    const badge = screen.getByTestId(`agent-turn-${KIM_AGENT}`);
    // 배지는 줄어들지 않는다 — 줄어들 수 있으면 「작업 중」이 「작…」이 된다.
    expect(badge.props.style?.flexShrink).toBeUndefined();
  });
});

describe('연결이 끊기면 화면이 그렇다고 말한다 (2R H2·M4)', () => {
  it('에이전트 탭은 고지를 띄우고, 배지는 색을 잃고, 라벨이 이유를 말한다', async () => {
    await openAgentsTab();
    expect(screen.queryByTestId('agents-offline')).toBeNull();

    await deliver(statusFrame(), 20);
    await deliver(statusFrame({phase: 'streaming', run_status: 'running'}), 45);
    const row = () => screen.getByTestId(`agent-row-${KIM_AGENT}`);
    await waitFor(() => expect(row()).toHaveTextContent(/작업 중/));

    await cutSocket();

    // ① 화면에 한 줄. 배지가 회색이 되는 것만으로는 부족하다 — 무색은 「열린 턴이
    //    없음」의 모양이기도 하다.
    await waitFor(() => expect(screen.getByTestId('agents-offline')).toBeTruthy());
    expect(screen.getByTestId('agents-offline')).toHaveTextContent(
      TURN_STALE_SENTENCE,
    );

    // ② 배지는 남는다(마지막으로 확인된 상태는 여전히 읽을 값이다) — 다만 색을
    //    잃는다. 살아 있는 주장과 기억된 주장이 같아 보이면 안 된다.
    const badge = screen.getByTestId(`agent-turn-${KIM_AGENT}`);
    expect(badge).toHaveTextContent(/작업 중/);
    expect(flatStyle(badge.props.style).borderColor).not.toBe(color.agent);

    // ③ 그리고 스크린리더가 듣는 문장에도 이유가 붙는다.
    expect(row().props.accessibilityLabel).toContain(TURN_STALE_SENTENCE);
  });

  it('대화 화면은 스테일 줄을 붙이고 시계를 멈추고 헤더 부제를 고친다', async () => {
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    await waitFor(() => expect(agentSub()).toBeTruthy());
    fireEvent.press(screen.getByTestId(`sidebar-row-channel:${GENERAL}`));
    await waitFor(() =>
      expect(screen.getByTestId('conversation-title')).toBeTruthy(),
    );

    await deliver(statusFrame(), 20);
    await deliver(statusFrame({phase: 'streaming', run_status: 'running'}), 45);
    await waitFor(() =>
      expect(screen.getByTestId('composer-working')).toBeTruthy(),
    );
    // 살아 있는 동안에는 경과 시계가 있다. `queued` 프레임이 시작 시각을 줬다.
    expect(screen.getByTestId('composer-working')).toHaveTextContent(/\d+s/);
    expect(screen.queryByTestId('composer-working-stale')).toBeNull();

    await cutSocket();

    // ① 그 자리에서 이유를 말하는 한 줄.
    await waitFor(() =>
      expect(screen.getByTestId('composer-working-stale')).toBeTruthy(),
    );
    // ② 시계는 멈추는 게 아니라 사라진다 — 죽은 소켓 위에서 세는 숫자는 우리의
    //    낙관을 재는 것이지 에이전트의 턴을 재는 것이 아니다.
    expect(screen.getByTestId('composer-working')).not.toHaveTextContent(/\d+s/);
    // ②' 그리고 스크린리더도 같은 것을 듣는다. RN View는 기본이 비접근 요소라
    //     `accessible` 없이는 이 라벨을 아무도 읽지 않는다 (M1).
    const bar = screen.getByTestId('composer-working');
    expect(bar.props.accessible).toBe(true);
    expect(bar.props.accessibilityLabel).toContain('김인턴');
    expect(bar.props.accessibilityLabel).toContain(TURN_STALE_SENTENCE);
    // ③ 헤더 부제가 활동 줄과 같은 말을 한다. 「연결 중…」이면 같은 화면에서 두
    //    문장이 서로를 부정한다 (M3).
    expect(screen.getByTestId('conversation-title').parent).toBeTruthy();
    expect(screen.getByText('연결이 끊겼습니다')).toBeTruthy();
    expect(screen.queryByText('연결 중…')).toBeNull();
  });
});

describe('대화 화면 — 입력창 바로 위에서 턴을 말한다', () => {
  async function openGeneral() {
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    await waitFor(() => expect(agentSub()).toBeTruthy());
    fireEvent.press(screen.getByTestId(`sidebar-row-channel:${GENERAL}`));
    await waitFor(() =>
      expect(screen.getByTestId('conversation-title')).toBeTruthy(),
    );
  }

  it('헤드라인이 없어도 누가 무엇을 하는지 말하고, 이름을 붙여 말한다', async () => {
    await openGeneral();
    expect(screen.queryByTestId('composer-working')).toBeNull();

    await deliver(statusFrame(), 20);
    await deliver(statusFrame({phase: 'streaming', run_status: 'running'}), 40);

    await waitFor(() =>
      expect(screen.getByTestId('composer-working')).toBeTruthy(),
    );
    // 헤드라인이 아직 없다 — 그래도 "김인턴이 작업 중"은 참이고 읽는 사람이
    // 원하는 것이다. 없는 헤드라인을 지어내지 않는다.
    const bar = screen.getByTestId('composer-working');
    expect(bar).toHaveTextContent(/김인턴/);
    expect(bar).toHaveTextContent(/작업 중/);

    // 에이전트가 한 줄을 흘리면 그 줄이 문장을 대신한다.
    await deliver(partialFrame({text: '테스트 3개 남았습니다'}), 30);
    await waitFor(() =>
      expect(screen.getByTestId('composer-working')).toHaveTextContent(
        /테스트 3개 남았습니다/,
      ),
    );
  });

  it('승인을 기다리는 턴은 승인을 기다린다고 말한다 — 그리고 헤드라인을 버린다', async () => {
    await openGeneral();
    await deliver(statusFrame(), 20);
    await deliver(statusFrame({phase: 'streaming', run_status: 'running'}), 40);
    await deliver(partialFrame({text: '파일을 지울까요'}), 25);
    await waitFor(() =>
      expect(screen.getByTestId('composer-working')).toHaveTextContent(
        /파일을 지울까요/,
      ),
    );

    await deliver(
      statusFrame({phase: 'thinking', run_status: 'awaiting_approval'}),
      35,
    );
    await waitFor(() =>
      expect(screen.getByTestId('composer-working')).toHaveTextContent(
        /승인을 기다립니다/,
      ),
    );
    const bar = screen.getByTestId('composer-working');
    expect(bar).not.toHaveTextContent(/작업 중/);
    // 기다리는 대상은 이미 타임라인의 메시지다. 상태 줄이 그것을 다시 인쇄하면
    // 화면이 자기 자신 위에 쌓인다.
    expect(bar).not.toHaveTextContent(/파일을 지울까요/);
  });
});
