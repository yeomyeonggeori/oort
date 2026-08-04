import type {Member} from '@momo/core/lib/api';
import {
  CANCEL_CONFIRM_SENTENCE,
} from '@momo/core/features/agents/runCancel';
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

import {CONFIRM_GUARD_MS} from '../src/features/inbox/ApprovalDecision';
import {resetAgentWorking} from '../src/features/agents/workingSignal';
import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// 「멈춰라」 — 사람이 도는 실행을 세운다 (goal RN-C1, ADR-0132 D1).
//
// ## 무엇을 가짜로 두는가
//
// 둘뿐이다: `fetch`가 무엇을 답했는가, 소켓이 무엇을 실어 왔는가. 그 아래는 전부
// 진짜다 — core의 `cancelAgentRun`, 409를 「이미 끝났습니다」로 읽는 규칙, 실패
// 문장, 확인 단계와 그 가드, 신호 스토어, 화면.
//
// **취소 함수를 mock하지 않는 것**이 특히 중요하다. mock하면 "확인 없이 중단이
// 전송되지 않는다"가 **호출 여부**에 대한 주장으로 약해지는데, 실제로 지켜야 하는
// 것은 **네트워크에 나가지 않는다**이다. 그래서 아래 red proof는 `fetch` 호출
// 목록을 직접 센다.
//
// ## 타이밍
//
// 프레임은 구독이 붙은 tick에 오지 않고(`deliver`가 실제로 기다린다), 취소 응답도
// 테스트가 여는 deferred로 붙잡아 「중단하는 중」을 실제로 관찰한다 (#839).
//
// 시계도 테스트가 쥔다. 확정 버튼은 뜬 직후 `CONFIRM_GUARD_MS` 동안 탭을 받지
// 않는데(더블탭이 확인 단계를 건너뛰는 구멍), 실제 시계로는 "빠른 두 번째 탭"과
// "읽고 나서 누른 탭"을 테스트가 구분해서 만들 수 없다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const KIM_AGENT = 'cccccccc-1111-4111-8111-cccccccccccc';
const GENERAL = 'ch-general';
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

const CANCEL_OK = {
  runId: RUN,
  status: 'cancelled',
  linkedWorkSessionIds: [],
  workSessionsTerminated: false,
};

interface FetchLog {
  mock: jest.Mock;
  /** 취소 POST만. red proof가 세는 것이 이것이다. */
  cancelCalls: () => unknown[][];
}

function installFetch(
  cancel?: () => Response | Promise<Response>,
): FetchLog {
  const mock = jest.fn(async (url: string) => {
    if (url.includes('/cancel')) {
      return cancel ? cancel() : jsonResponse(200, CANCEL_OK);
    }
    if (url.includes('/work-sessions')) return jsonResponse(200, {workSessions: []});
    if (url.includes('/work-hosts')) return jsonResponse(200, {workHosts: []});
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
  return {
    mock,
    cancelCalls: () =>
      mock.mock.calls.filter(([url]) => String(url).includes('/cancel')),
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

/** 구독이 붙은 tick에 답하지 않는다 (#839). */
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

/** 대화를 열고, 열린 턴 하나를 만들어 둔다. */
async function openTurn(): Promise<void> {
  renderShell();
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
  await waitFor(() => expect(agentSub()).toBeTruthy());
  fireEvent.press(screen.getByTestId(`sidebar-row-channel:${GENERAL}`));
  await waitFor(() =>
    expect(screen.getByTestId('conversation-title')).toBeTruthy(),
  );
  await deliver(statusFrame(), 20);
  await deliver(statusFrame({phase: 'streaming', run_status: 'running'}), 40);
  await waitFor(() =>
    expect(screen.getByTestId('composer-working')).toBeTruthy(),
  );
}

const ARM = `turn-stop-${KIM_AGENT}-arm`;
const COMMIT = `turn-stop-${KIM_AGENT}-commit`;
const DISMISS = `turn-stop-${KIM_AGENT}-dismiss`;

/** 가드 창을 지나서 누른 탭. 시계를 쥐지 않으면 만들 수 없는 상황이다. */
function pressAfterGuard(testID: string): void {
  const real = Date.now;
  jest.spyOn(Date, 'now').mockImplementation(() => real() + CONFIRM_GUARD_MS + 50);
  fireEvent.press(screen.getByTestId(testID));
  (Date.now as unknown as jest.Mock).mockRestore();
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

describe('중단은 두 번의 탭이고, 첫 번째는 아무것도 보내지 않는다', () => {
  it('RED PROOF — 확인 없이는 취소 요청이 네트워크에 나가지 않는다', async () => {
    const log = installFetch();
    await openTurn();

    // 첫 탭. 이것은 중단하지 않고, 중단할지 묻는다.
    fireEvent.press(screen.getByTestId(ARM));
    await waitFor(() =>
      expect(screen.getByTestId(`turn-stop-${KIM_AGENT}-confirm`)).toBeTruthy(),
    );
    expect(screen.getByTestId(`turn-stop-${KIM_AGENT}-confirm`)).toHaveTextContent(
      new RegExp(CANCEL_CONFIRM_SENTENCE.replace(/[.]/g, '\\.')),
    );
    // 호출 여부가 아니라 **와이어**를 센다. 취소 함수를 mock했다면 이 단정은
    // 아무것도 지키지 못한다.
    expect(log.cancelCalls()).toHaveLength(0);

    // 그대로 두기 — 여전히 아무것도 나가지 않았다.
    fireEvent.press(screen.getByTestId(DISMISS));
    await waitFor(() => expect(screen.getByTestId(ARM)).toBeTruthy());
    expect(log.cancelCalls()).toHaveLength(0);
  });

  it('가드 창 안의 두 번째 탭은 확인이 아니라 같은 한 번의 동작이다', async () => {
    const log = installFetch();
    await openTurn();

    fireEvent.press(screen.getByTestId(ARM));
    await waitFor(() => expect(screen.getByTestId(COMMIT)).toBeTruthy());
    // 확정 버튼이 방금 누른 버튼 자리에 떴다. 엄지에게 그 둘은 같은 지점이다.
    fireEvent.press(screen.getByTestId(COMMIT));

    expect(log.cancelCalls()).toHaveLength(0);
    // 조용히 무시하지 않는다: 아무 일도 없는 버튼은 고장난 버튼과 구별되지 않고,
    // 그 자리에서 사람이 하는 다음 행동은 더 세게 두 번 누르는 것이다.
    expect(
      screen.getByTestId(`turn-stop-${KIM_AGENT}-too-fast`),
    ).toBeTruthy();

    // 읽고 나서 누른 탭은 나간다.
    pressAfterGuard(COMMIT);
    await waitFor(() => expect(log.cancelCalls()).toHaveLength(1));
  });
});

describe('세 가지 답', () => {
  it('성공 — 무엇이 멈췄고 무엇이 계속 도는지 함께 말한다', async () => {
    // 서버는 연결된 작업 세션을 **끝내지 않는다**(`workSessionsTerminated: false`).
    // 영수증이 그 절반을 빼면, 터미널이 계속 도는데 멈췄다고 말하는 것이 된다.
    let release: (() => void) | null = null;
    const log = installFetch(
      () =>
        new Promise<Response>(resolve => {
          release = () =>
            resolve(
              jsonResponse(200, {
                ...CANCEL_OK,
                linkedWorkSessionIds: ['SESSION-A', 'SESSION-B'],
              }),
            );
        }),
    );
    await openTurn();

    fireEvent.press(screen.getByTestId(ARM));
    await waitFor(() => expect(screen.getByTestId(COMMIT)).toBeTruthy());
    pressAfterGuard(COMMIT);

    // 답을 붙잡아 둔 동안 「중단하는 중」이 실제로 화면에 있다. 이미 resolve된
    // 목에 대고 단정하면 아무것도 증명하지 못한다 (#839).
    await waitFor(() =>
      expect(screen.getByTestId(COMMIT)).toHaveTextContent(/중단하는 중/),
    );
    expect(log.cancelCalls()).toHaveLength(1);

    await act(async () => {
      release!();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    await waitFor(() =>
      expect(screen.getByTestId('turn-stop-outcome-cancelled')).toBeTruthy(),
    );
    const receipt = screen.getByTestId('turn-stop-outcome-cancelled');
    expect(receipt).toHaveTextContent(/이 실행을 중단했습니다/);
    expect(receipt).toHaveTextContent(/작업 세션 2개는 계속 돕니다/);
  });

  it('이미 터미널 — 409는 오류가 아니라 「이미 끝났습니다」다', async () => {
    installFetch(() =>
      jsonResponse(409, {error: {message: 'run already terminal'}}),
    );
    await openTurn();

    fireEvent.press(screen.getByTestId(ARM));
    await waitFor(() => expect(screen.getByTestId(COMMIT)).toBeTruthy());
    pressAfterGuard(COMMIT);

    await waitFor(() =>
      expect(screen.getByTestId('turn-stop-outcome-alreadyOver')).toBeTruthy(),
    );
    expect(screen.getByTestId('turn-stop-outcome-alreadyOver')).toHaveTextContent(
      /이 실행은 이미 끝났습니다\./,
    );
    // 실패로 그리지 않는다 — 사람이 원한 것(이 실행이 돌지 않는 것)은 참이 됐다.
    expect(screen.queryByTestId('turn-stop-outcome-error')).toBeNull();
    // 확인 단계도 접힌다. 남겨 두면 존재하지 않는 실행을 다시 멈추라고 권하는
    // 버튼이 화면에 남는다.
    await waitFor(() => expect(screen.getByTestId(ARM)).toBeTruthy());
  });

  it('오프라인 — 실행은 그대로라고 말한다', async () => {
    installFetch(() => Promise.reject(new TypeError('Network request failed')));
    await openTurn();

    fireEvent.press(screen.getByTestId(ARM));
    await waitFor(() => expect(screen.getByTestId(COMMIT)).toBeTruthy());
    pressAfterGuard(COMMIT);

    await waitFor(() =>
      expect(screen.getByTestId('turn-stop-outcome-error')).toBeTruthy(),
    );
    const banner = screen.getByTestId('turn-stop-outcome-error');
    expect(banner).toHaveTextContent(/중단하지 못했습니다/);
    // 아무것도 나가지 않았으므로 반쯤 일어난 일도 없다. 그 사실을 말하는 것이
    // 사람이 "그래도 멈췄겠지"라고 넘겨짚는 것을 막는다.
    expect(banner).toHaveTextContent(/실행은 그대로입니다/);
    // 다시 시도할 수 있게 확인 단계는 그대로 서 있다.
    expect(screen.getByTestId(COMMIT)).toBeTruthy();
  });
});

describe('중단을 권하지 않는 자리', () => {
  it('연결이 끊긴 동안에는 중단 버튼이 없다', async () => {
    installFetch();
    await openTurn();
    expect(screen.getByTestId(ARM)).toBeTruthy();

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 15));
      client().__emit('disconnected', {});
    });

    // 마지막으로 확인된 상태를 보고 있는 것이고, 그 실행은 이미 끝났을 수 있다.
    // 끊긴 화면에서 「중단」을 권하는 것은 무엇을 멈추는지 모르는 채 누르게 하는 것.
    await waitFor(() => expect(screen.queryByTestId(ARM)).toBeNull());
    expect(screen.getByTestId('composer-working-stale')).toBeTruthy();
  });

  it('열린 턴이 없으면 아무것도 없다', async () => {
    installFetch();
    renderShell();
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    await waitFor(() => expect(agentSub()).toBeTruthy());
    fireEvent.press(screen.getByTestId(`sidebar-row-channel:${GENERAL}`));
    await waitFor(() =>
      expect(screen.getByTestId('conversation-title')).toBeTruthy(),
    );
    expect(screen.queryByTestId('composer-working')).toBeNull();
    expect(screen.queryByTestId(ARM)).toBeNull();
  });
});
