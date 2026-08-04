import type {Member} from '@momo/core/lib/api';
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

import {resetAgentWorking} from '../src/features/agents/workingSignal';
import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// 앱을 쓰는 중에 도착한 승인이 인박스에 뜬다 (goal RN-B4d / #1020)
//
// MAESTRO 레인 30-approval 이 실측한 결함: 승인이 DB 에서 `pending` 이고 채널에는
// 실시간으로 떠 있는 동안, 인박스는 60초 내내 「지금 결정할 일이 없습니다. 조용한 게
// 정상입니다.」였다. 레인은 그 60초를 **앱 재기동**으로 우회하고 있었다.
//
// 원인은 리얼타임이 아니다 — 채널이 그것을 증명했다. 원인은 셋이 겹친 것이었다:
//
//   1. `FEED_STALE_MS = 15_000` — 피드는 자기 답을 15초 쥔다.
//   2. 탭은 `display:'none'` 으로 숨을 뿐 언마운트되지 않는다(`AppShell`). 그래서
//      탭을 여는 것이 **마운트가 아니고**, react-query 에는 재조회를 걸 계기가 없다.
//   3. 리얼타임 이벤트가 승인 쿼리를 무효화하지 않는다.
//
// 이 파일은 그 셋을 각각 잰다. 목은 `fetch` 와 소켓 둘뿐이고, 그 아래 react-query
// 배선·레일·화면은 전부 진짜다.
//
// 신호는 새로 만들지 않았다. `agent.status` 의 `run_status: "awaiting_approval"` 은
// **이미 이 앱을 지나가고 있었고**(`AgentWorkingRail` 이 워크스페이스 전체의 에이전트
// 채널을 듣는다), 인박스가 소켓을 하나 더 열 이유가 없다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const KIM_AGENT = 'cccccccc-1111-4111-8111-cccccccccccc';
const GENERAL = 'ch-general';
const RUN = 'A1111111-1111-4111-8111-A11111111111';
const APPROVAL = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
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

function rosterMember(over: Record<string, unknown>) {
  return {
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    displayName: '이름',
    handle: 'handle',
    channelCount: 1,
    channelIds: [GENERAL],
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
    ownerHumanId: SELF_ID,
  }),
];

const CHANNELS = [
  {id: GENERAL, workspaceId: WS, kind: 'public', name: 'general', muted: false},
];

/** 서버가 실제로 보내는 모양 (camelCase — `dto.rs` ApprovalDto). */
function wireApproval() {
  return {
    id: APPROVAL,
    workspaceId: WS,
    runId: 'run-1',
    channelId: GENERAL,
    requestedBy: KIM_AGENT,
    actionType: 'tool_call',
    payload: {
      run_id: 'run-1',
      action_type: 'tool_call',
      tool_call: {
        call_id: 'call-1',
        name: 'work.session.end',
        arguments: '{}',
        arguments_json: {},
      },
      approval_reason: 'irreversible tool',
    },
    status: 'pending',
    expiresAtMs: 1_700_000_600_000,
    createdAtMs: 1_699_999_000_000,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * 원장은 **서버처럼** 답한다: 승인이 열리기 전에는 비어 있고, 열린 뒤에는 그 행을
 * 몇 번을 읽든 계속 답한다. 「첫 조회에만 있다」는 서버가 하지 않을 답이고, 그렇게
 * 쓰면 이 배치가 고치는 재조회를 픽스처가 벌로 바꿔 버린다.
 */
let approvalOpen = false;

function installFetch(): jest.Mock {
  const mock = jest.fn(async (url: string) => {
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/work-sessions')) return jsonResponse(200, {sessions: []});
    if (url.includes('/work-hosts')) return jsonResponse(200, {hosts: []});
    if (url.includes('/channels') && !url.includes('/messages')) {
      return jsonResponse(200, {channels: CHANNELS});
    }
    if (url.includes('/roster')) return jsonResponse(200, {members: ROSTER});
    if (url.includes('/read-state')) return jsonResponse(200, {read_states: []});
    if (url.includes('/messages')) return jsonResponse(200, {messages: []});
    if (url.includes('/approvals')) {
      const pending = url.includes('status=pending');
      return jsonResponse(200, {
        approvals: pending && approvalOpen ? [wireApproval()] : [],
      });
    }
    if (url.includes('/agent-runs') || url.includes('/runs')) {
      return jsonResponse(200, {runs: []});
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
      phase: 'thinking',
      run_status: 'running',
      ...over,
    },
  };
}

/**
 * 프레임은 **부탁한 tick 에 오지 않는다** (#839 의 교훈, 이 레포의 다른 레일
 * 테스트와 같은 이유). 오기 전 상태를 먼저 확인하고, 그 다음에 온 뒤를 본다.
 */
async function deliver(data: unknown, delayMs: number): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    agentSub()?.__emit('publication', {data});
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

const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;

beforeEach(() => {
  approvalOpen = false;
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

/**
 * 사람이 채널을 보고 있다 — 인박스는 뒤에 마운트된 채 숨어 있고, 에이전트 레일은
 * 워크스페이스 전체를 듣고 있다. 결함이 살던 정확히 그 자세다.
 */
async function readingAChannel() {
  renderShell();
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
  // 인박스를 한 번 열어 피드에 답을 쥐여 준다(= 15초 창이 열린다). 그러지 않으면
  // 「낡은 답을 들고 있었다」가 아니라 「아직 아무것도 못 받았다」를 재게 된다.
  fireEvent.press(screen.getByTestId('tab-inbox'));
  await waitFor(() => expect(screen.getByTestId('inbox-empty')).toBeTruthy());
  fireEvent.press(screen.getByTestId('tab-channels'));
  await waitFor(() => expect(agentSub()).toBeTruthy());
}

describe('앱을 쓰는 중에 도착한 승인', () => {
  it('승인 대기 프레임이 오면 인박스가 원장을 다시 읽는다 — 탭을 열기도 전에', async () => {
    // ## 결함 그 자체.
    //
    // 이 단정이 깨지면 승인은 DB 에서 `pending` 인 채로 인박스에 뜨지 않고, 사람은
    // 「지금 결정할 일이 없습니다」를 읽는다. 레인이 60초를 기다린 뒤 앱을 재기동해야
    // 했던 이유가 이 한 줄이다.
    await readingAChannel();

    // 서버에서 승인이 열렸다. 화면은 아직 그것을 모른다 — 피드는 자기 답을 쥐고 있다.
    approvalOpen = true;
    await deliver(statusFrame(), 20);

    // 그리고 그 런이 승인 대기로 넘어갔다는 프레임이 온다.
    await deliver(
      statusFrame({phase: 'thinking', run_status: 'awaiting_approval'}),
      45,
    );

    // 탭을 여는 것은 그 다음이다. 무효화가 먼저 일어났으므로 목록에는 이미 행이 있다.
    fireEvent.press(screen.getByTestId('tab-inbox'));
    await waitFor(() =>
      expect(screen.getByTestId(`feed-row-approval:${APPROVAL}`)).toBeTruthy(),
    );
  });

  it('같은 상태의 반복 프레임은 원장을 다시 읽지 않는다', async () => {
    // 무효화의 조건은 「승인 대기다」가 아니라 「**바뀌었다**」다. 그러지 않으면
    // 스트리밍하는 턴 하나가 원장 재조회 폭풍이 된다.
    const fetchMock = installFetch();
    await readingAChannel();
    await deliver(
      statusFrame({phase: 'thinking', run_status: 'awaiting_approval'}),
      20,
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) =>
          String(url).includes('/approvals?status=pending'),
        ).length,
      ).toBeGreaterThan(0),
    );
    const asked = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/approvals?status=pending'),
    ).length;

    await deliver(
      statusFrame({phase: 'thinking', run_status: 'awaiting_approval'}),
      30,
    );
    await deliver(
      statusFrame({phase: 'streaming', run_status: 'awaiting_approval'}),
      30,
    );

    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/approvals?status=pending'),
      ).length,
    ).toBe(asked);
  });

  it('탭을 여는 것 자체도 원장을 다시 읽는다 — 소켓이 세워져 있던 동안의 것', async () => {
    // 리얼타임이 대부분을 덮지만 전부는 아니다. 백그라운드 정책이 소켓을 park 한
    // 동안 도착한 승인은 어떤 프레임으로도 오지 않는다. 사람이 탭을 여는 그 순간이
    // 「지금 결정할 일이 없습니다」가 아직 참인지 물어보기 가장 좋은 때다.
    const fetchMock = installFetch();
    await readingAChannel();

    approvalOpen = true;
    const before = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/approvals?status=pending'),
    ).length;

    fireEvent.press(screen.getByTestId('tab-inbox'));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) =>
          String(url).includes('/approvals?status=pending'),
        ).length,
      ).toBeGreaterThan(before),
    );
    await waitFor(() =>
      expect(screen.getByTestId(`feed-row-approval:${APPROVAL}`)).toBeTruthy(),
    );
  });
});
