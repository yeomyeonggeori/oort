import type {Member} from '@momo/core/lib/api';
import {centrifugoChannelName} from '@momo/core/lib/realtimeEvents';
import {focusManager, QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {resetAgentWorking} from '../src/features/agents/workingSignal';
import {
  PENDING_APPROVALS_POLL_MS,
  pendingApprovalsKey,
} from '../src/features/conversation/usePendingApprovals';
import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';
import {
  installAppClock,
  SHELL_WAIT_TEST_TIMEOUT_MS,
} from './fixtures/fakeClock';

// =============================================================================
// 승인 원장이 제때 바뀐다 — 홈 「작업 중」 카드가 승인을 따라가는 시각 (#5125, #5085 후속)
//
// 홈 카드·에이전트 탭은 대화 화면과 같은 승인 원장 캐시를 읽는다(#5085). 그 캐시가 폰에서는 레일의 `run_status` 변화·알림 탭·결정 뒤·
// 인박스 열기로만 다시 읽혔고, 서버는 승인에 걸린 run 을 그 프레임으로 알리지 않는다(중간 프레임은 늘 `running`). 그래서 승인이 생긴
// 순간에는 어느 길도 울리지 않았다 — 덮어쓰기 배선이 옳아도 원장이 낡으면 화면은 「작업 중」(또는 카드 없음)에 머문다.
//
// 이 파일은 갱신 길 넷을 각각 잰다. 목은 `fetch` 와 소켓 둘뿐이고, 그 아래 react-query 배선·레일·`ApprovalsLiveSync`·홈 카드는 전부 진짜다.
// 「안 바뀐다」 단정은 원장이 읽힌 것을 먼저 확인한 뒤에 한다(#839 의 교훈: 아직 아무것도 못 받은 것을 재면 아무것도 증명하지 못한다).
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const KIM_AGENT = 'cccccccc-1111-4111-8111-cccccccccccc';
const GENERAL = 'ch-general';
const BASE = 'https://api.example.com';

const SELF: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '시험 사용자',
  handle: 'tester',
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
  rosterMember({id: SELF_ID, displayName: '시험 사용자', handle: 'tester'}),
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

/** 서버가 실제로 보내는 모양 (camelCase — `dto.rs` ApprovalDto). 기한은 읽는 순간의 시계로 잡는다(가짜 시계를 따라간다). */
function wireApproval() {
  return {
    id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    workspaceId: WS,
    runId: 'run-1',
    channelId: GENERAL,
    requestedBy: KIM_AGENT,
    actionType: 'tool_call',
    status: 'pending',
    expiresAtMs: Date.now() + 3_600_000,
    createdAtMs: Date.now(),
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
 * 원장은 **서버처럼** 답한다: 승인이 열리기 전에는 비어 있고, 열린 뒤에는 읽을 때마다 그 행을 답한다. 「첫 조회에만 있다」는 서버가 하지
 * 않을 답이다.
 */
let approvalOpen = false;
/** 아직 이 경로를 배포하지 않은 서버: 원장 요청이 404 로 돌아온다. */
let approvalsAbsent = false;

const PENDING_URL = '/approvals?status=pending';

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
      if (approvalsAbsent) return jsonResponse(404, {error: {message: 'not found'}});
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
  __subscribed: (options?: {recovered?: boolean}) => void;
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

/** 채널 구독 하나 — 메시지·승인 카드 프레임이 오는 곳이고, 레일의 진행 읽기도 같은 구독을 나눠 쓴다. */
function channelSub(): FakeSubscription | null {
  return client()?.getSubscription(centrifugoChannelName(WS, GENERAL)) ?? null;
}

function messageFrame(type: string) {
  return {
    type: 'message.new',
    v: 1,
    ts: Date.now(),
    seq: 7,
    payload: {
      id: '019F96A4-E717-7F82-9750-58B2D7D28226',
      channel_id: GENERAL,
      seq: 7,
      type,
      author_member_id: KIM_AGENT,
      hlc_ts: 1,
      hlc_count: 0,
    },
  };
}

/** 프레임은 **부탁한 tick 에 오지 않는다**: 합치는 250ms 를 지난 뒤를 본다. */
async function deliver(data: unknown): Promise<void> {
  await act(async () => {
    channelSub()?.__emit('publication', {data});
    await jest.advanceTimersByTimeAsync(300);
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

let queryClient: QueryClient | null = null;
let fetchMock: jest.Mock;

const askedLedger = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes(PENDING_URL)).length;

/**
 * 앱이 떠 있고 홈 탭이 보인다. 원장은 한 번 읽혔고(승인 없음) 채널 구독이 서 있다 — 결함이 살던 자세 그대로다.
 */
async function homeIsOpen(): Promise<void> {
  queryClient = new QueryClient({
    defaultOptions: {
      // 제품 클라이언트(`query/queryClient.ts` `createQueryClient`)의 두 기본값을 그대로 둔다: focus 재조회는 꺼 있고 답은 30초 신선하다.
      // 이 시험이 재는 것 하나는 「이 원장 쿼리가 focus 재조회를 스스로 켠다」이므로, 전역 기본이 켜 있는 하네스에서는 그 줄이 지워져도
      // 아무것도 붉어지지 않는다(실제로 그랬다).
      queries: {retry: false, gcTime: 0, refetchOnWindowFocus: false, staleTime: 30_000},
      mutations: {retry: false, gcTime: 0},
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AppShell member={SELF} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
  await waitFor(() => expect(channelSub()).toBeTruthy());
  await waitFor(() => expect(askedLedger()).toBeGreaterThan(0));
  expect(screen.queryByTestId('home-working-card')).toBeNull();
}

const mmkvStore = (
  jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
).__store;

jest.setTimeout(SHELL_WAIT_TEST_TIMEOUT_MS);

beforeEach(() => {
  installAppClock();
  approvalOpen = false;
  approvalsAbsent = false;
  mmkvStore.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  centrifugeMock.__reset();
  resetAgentWorking();
  sessionPort.applyLogin(LOGIN_BODY);
  fetchMock = installFetch();
});

afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
  queryClient?.clear();
  queryClient = null;
  resetAgentWorking();
  jest.useRealTimers();
});

describe('승인 원장이 제때 바뀐다 (#5125)', () => {
  it('승인 카드 프레임이 오면 원장을 다시 읽고 홈 카드가 「승인 필요」로 선다 — 레일 프레임도 인박스 열기도 없이', async () => {
    await homeIsOpen();

    // 서버에서 승인이 열렸다. 홈은 아직 그것을 모른다 — 원장은 낡았고 레일에는 아무 프레임도 없었다.
    approvalOpen = true;
    const before = askedLedger();

    // 보통 메시지는 원장을 묻지 않는다: 그러지 않으면 채팅이 오갈 때마다 원장 재조회 폭풍이 된다.
    await deliver(messageFrame('text'));
    expect(askedLedger()).toBe(before);
    expect(screen.queryByTestId('home-working-card')).toBeNull();

    // 승인 카드(`approval_request`)가 채널에 올라온다.
    await deliver(messageFrame('approval_request'));
    await waitFor(() =>
      expect(screen.getByTestId('home-working-state')).toHaveTextContent('승인 필요'),
    );
    expect(askedLedger()).toBeGreaterThan(before);
  });

  it('재구독하면 끊긴 동안 놓친 승인을 원장에서 고친다 — 프레임이 하나도 오지 않아도', async () => {
    await homeIsOpen();
    approvalOpen = true;
    const before = askedLedger();

    // 소켓이 내려갔다 올라왔다: 되살린 프레임이 없다(`recovered: false`). 놓친 것은 읽기로만 고쳐진다.
    await act(async () => {
      channelSub()?.__subscribed({recovered: false});
      await jest.advanceTimersByTimeAsync(300);
    });

    await waitFor(() =>
      expect(screen.getByTestId('home-working-state')).toHaveTextContent('승인 필요'),
    );
    expect(askedLedger()).toBeGreaterThan(before);
  });

  it(`앞에 있는 동안 ${PENDING_APPROVALS_POLL_MS / 1000}초마다 원장을 다시 읽는다 — 프레임이 없는 승인의 그물, 주기를 가진 관측자는 하나뿐`, async () => {
    await homeIsOpen();
    approvalOpen = true;
    const before = askedLedger();

    // 다시 읽는 주기를 가진 관측자는 **하나**다(셸의 지키는 훅). react-query 는 관측자마다 타이머를 돌리므로 읽는 훅(홈·에이전트 탭·대화)마다 주기를
    // 달면 열린 화면 수만큼 같은 요청이 는다. 가짜 시계에서는 그 타이머들이 같은 순간에 울려 요청 수로는 구별되지 않아서 관측자를 직접 센다.
    const observers =
      queryClient!.getQueryCache().find({queryKey: pendingApprovalsKey(WS)})?.observers ?? [];
    // 홈의 읽는 훅 + 셸의 지키는 훅. 하나뿐이면 아래 단정이 아무것도 증명하지 못한다.
    expect(observers.length).toBeGreaterThan(1);
    expect(
      observers.filter(
        observer =>
          observer.options.refetchInterval !== undefined &&
          observer.options.refetchInterval !== false,
      ),
    ).toHaveLength(1);

    // 주기 전에는 조용하고(폭풍이 아니다), 주기가 지나면 읽는다.
    await advance(PENDING_APPROVALS_POLL_MS - 2_000);
    expect(askedLedger()).toBe(before);
    await advance(4_000);
    expect(askedLedger()).toBeGreaterThan(before);
    await waitFor(() =>
      expect(screen.getByTestId('home-working-state')).toHaveTextContent('승인 필요'),
    );
  });

  it('뒤에 있는 동안은 읽지 않고, 앞으로 돌아오면 낡은 원장을 바로 다시 읽는다', async () => {
    await homeIsOpen();
    approvalOpen = true;

    // 앱이 뒤로 갔다. 30초 주기가 몇 번을 지나도 묻지 않는다(폰의 라디오).
    act(() => focusManager.setFocused(false));
    const before = askedLedger();
    await advance(PENDING_APPROVALS_POLL_MS * 2 + 5_000);
    expect(askedLedger()).toBe(before);
    expect(screen.queryByTestId('home-working-card')).toBeNull();

    // 앞으로 돌아온다: 주기를 기다리지 않고 바로 읽는다(마지막으로 읽은 지 30초가 넘었다).
    await act(async () => {
      focusManager.setFocused(true);
      await jest.advanceTimersByTimeAsync(100);
    });
    expect(askedLedger()).toBeGreaterThan(before);
    await waitFor(() =>
      expect(screen.getByTestId('home-working-state')).toHaveTextContent('승인 필요'),
    );
  });

  it('이 서버에 원장 경로가 없으면(404) 30초마다 두드리지 않는다 — 없는 경로를 계속 묻는 폭풍이 아니다', async () => {
    approvalsAbsent = true;
    await homeIsOpen();
    const before = askedLedger();

    await advance(PENDING_APPROVALS_POLL_MS * 3);
    expect(askedLedger()).toBe(before);
  });
});
