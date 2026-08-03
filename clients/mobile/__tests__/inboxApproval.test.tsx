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
import React from 'react';
import {AccessibilityInfo} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {CONFIRM_GUARD_MS} from '../src/features/inbox/ApprovalDecision';
import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// 인앱 승인 결정 (goal M-AP1).
//
// 승인은 이 제품에서 **되돌릴 수 없을 수 있는 유일한 행동**이다. 그래서 이 파일이
// 지키는 것은 "버튼이 동작한다"가 아니라 그 반대에 가깝다: 확인 없이는 아무것도
// 전송되지 않고, 결정할 수 없는 행에는 컨트롤이 아예 없다.
//
// ## 무엇을 가짜로 두는가
//
// `fetch`가 무엇을 답했는가, 그리고 이 서버가 승인을 싣는가 — 그 둘뿐이다.
// core의 `decideApproval`·`interpretReceipt`, 멱등키 정책, react-query 배선, 행
// 모델, 화면은 전부 진짜다. 특히 결정 함수를 mock하지 않는 것이 중요하다:
// mock하면 "확인 없이 결정이 전송되지 않는다"가 **호출 여부**에 대한 주장으로
// 약해지는데, 실제로 지켜야 하는 것은 **네트워크에 나가지 않는다**이다.
//
// 표면 판정만은 갈아끼운다. `serverSurfaces`의 `provided: false`를 뒤집는 것은
// 병렬 티켓 W-AP1의 몫이고(그 파일은 core에 있다), 이 티켓의 UI는 그 플립에
// 의존하지 않은 채 `isSurfaceProvided('approvals')` 게이트 아래에서 서야 한다.
// 그래서 판정 함수 하나만 픽스처로 감싼다 — 나머지 표(문구·근거)는 진짜 그대로다.
//
// ## 타이밍
//
// #839의 교훈: 목이 같은 tick에 답하면 "보내는 중"을 단언해도 헛초록이다. 결정
// 응답은 테스트가 직접 여는 deferred로 잡아 두고, 그 사이에 상태를 확인한다.
//
// 시계도 테스트가 쥔다. 확정 버튼은 뜬 직후 `CONFIRM_GUARD_MS` 동안 탭을 받지
// 않는데(더블탭이 확인 단계를 건너뛰는 구멍 — 아래 red proof ①이 잡아낸 것),
// 실제 시계로는 "빠른 두 번째 탭"과 "읽고 나서 누른 탭"을 테스트가 구분해서
// 만들어낼 수 없다. `Date.now`를 손에 쥐면 둘 다 정확히 만들 수 있다.
// =============================================================================

// jest는 `jest.mock` 팩토리를 파일 선언 위로 끌어올리므로 밖에서 읽는 이름은
// `mock` 접두사여야 한다. 값은 렌더 시점에 읽히니 TDZ 문제는 없다.
let mockApprovalsProvided = true;

jest.mock('@momo/core/features/capabilities/serverSurfaces', () => {
  const actual = jest.requireActual(
    '@momo/core/features/capabilities/serverSurfaces',
  );
  return {
    ...actual,
    isSurfaceProvided: (id: string) =>
      id === 'approvals' ? mockApprovalsProvided : actual.isSurfaceProvided(id),
  };
});

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const KIM_AGENT = 'cccccccc-1111-4111-8111-cccccccccccc';
const PENDING = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const IRREVERSIBLE = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const SETTLED = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';
const CHANNEL = 'ch-general';
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

const ROSTER = [
  {
    id: SELF_ID,
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    displayName: '곽성재',
    handle: 'seongjae',
    channelCount: 1,
    channelIds: [CHANNEL],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: KIM_AGENT,
    workspaceId: WS,
    kind: 'agent',
    status: 'active',
    displayName: '김인턴',
    handle: 'kim-intern',
    ownerHumanId: SELF_ID,
    channelCount: 1,
    channelIds: [CHANNEL],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];

const CHANNELS = [
  {id: CHANNEL, workspaceId: WS, kind: 'public', name: 'general', muted: false},
];

/** `GET …/approvals` 한 행. 와이어는 snake_case다 (core `WireApproval`). */
function wireApproval(over: Record<string, unknown> = {}) {
  return {
    id: PENDING,
    workspace_id: WS,
    run_id: 'run-1',
    channel_id: CHANNEL,
    requested_by: KIM_AGENT,
    action_type: 'work.spawn',
    status: 'pending',
    is_reversible: true,
    expires_at_ms: 1_700_000_600_000,
    ...over,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface RouteOverrides {
  /** `GET …/approvals?status=…` 한 페이지. */
  approvals?: (status: string) => Response | Promise<Response>;
  /** `POST …/approvals/{id}/decision`. */
  decision?: (
    approvalId: string,
    body: {approve: boolean; client_decision_id: string},
  ) => Response | Promise<Response>;
}

interface Fixture {
  fetch: jest.Mock;
  /** 이 실행에서 나간 결정 요청들 — 몇 번, 어떤 키로 나갔는지. */
  decisions: () => {approvalId: string; approve: boolean; key: string}[];
}

function installFetch(overrides: RouteOverrides = {}): Fixture {
  const decisions: {approvalId: string; approve: boolean; key: string}[] = [];
  const mock = jest.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.includes('/decision')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const approvalId = target.split('/approvals/')[1].split('/')[0];
      decisions.push({
        approvalId,
        approve: body.approve,
        key: body.client_decision_id,
      });
      return overrides.decision
        ? overrides.decision(approvalId, body)
        : jsonResponse(200, {
            approval_id: approvalId,
            status: body.approve ? 'approved' : 'rejected',
            decided_by: SELF_ID,
            decided_at_ms: 1_700_000_000_000,
          });
    }
    if (target.includes('/approvals')) {
      const status = new URL(target).searchParams.get('status') ?? 'pending';
      return overrides.approvals
        ? overrides.approvals(status)
        : jsonResponse(200, {
            approvals: status === 'pending' ? [wireApproval()] : [],
          });
    }
    if (target.includes('/agent-runs')) return jsonResponse(200, {runs: []});
    if (target.includes('/roster')) return jsonResponse(200, {members: ROSTER});
    if (target.includes('/read-state')) return jsonResponse(200, {read_states: []});
    if (target.includes('/messages')) return jsonResponse(200, {messages: []});
    if (target.includes('/channels')) return jsonResponse(200, {channels: CHANNELS});
    throw new Error(`unrouted request: ${target}`);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return {fetch: mock, decisions: () => decisions};
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

async function openInbox() {
  renderShell();
  await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
  fireEvent.press(screen.getByTestId('tab-inbox'));
  await waitFor(() => expect(screen.getByTestId('header-title')).toBeTruthy());
}

/** 대기 행이 목록에 그려질 때까지. */
async function openPendingRow(approvalId = PENDING) {
  await openInbox();
  await waitFor(() =>
    expect(screen.getByTestId(`feed-row-approval:${approvalId}`)).toBeTruthy(),
  );
  return screen.getByTestId(`feed-row-approval:${approvalId}`);
}

/** 테스트가 쥔 시계. `read` 한 문장을 읽는 사람만큼 시간을 흘린다. */
let nowMs = 1_700_000_000_000;
function elapse(ms: number): void {
  nowMs += ms;
}

/** 무장하고, 확정 문장을 읽을 만큼 기다린 뒤 확정한다 — 사람이 하는 순서 그대로. */
function armAndCommit(approvalId: string, direction: 'approve' | 'reject'): void {
  fireEvent.press(screen.getByTestId(`inbox-approval-${approvalId}-${direction}`));
  elapse(CONFIRM_GUARD_MS + 100);
  fireEvent.press(screen.getByTestId(`inbox-approval-${approvalId}-commit`));
}

beforeEach(() => {
  nowMs = 1_700_000_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
  mockApprovalsProvided = true;
  mmkvStore.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin(LOGIN_BODY);
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  queryClient = null;
  jest.restoreAllMocks();
});

// ---- 네 가지 상태 ----------------------------------------------------------

describe('결정 대기 목록의 네 가지 상태', () => {
  it('불러오는 동안에는 로딩을 말한다', async () => {
    // 답을 붙잡아 둔다. 이미 resolve된 목에 대고 로딩을 단언하면 아무것도
    // 증명하지 못한다 (#839).
    let release: (() => void) | null = null;
    installFetch({
      approvals: () =>
        new Promise<Response>(resolve => {
          release = () => resolve(jsonResponse(200, {approvals: [wireApproval()]}));
        }),
    });
    await openInbox();
    await waitFor(() => expect(screen.getByTestId('inbox-loading')).toBeTruthy());
    expect(screen.queryByTestId(`inbox-approval-${PENDING}-approve`)).toBeNull();

    release!();
    await waitFor(() =>
      expect(screen.getByTestId(`inbox-approval-${PENDING}-approve`)).toBeTruthy(),
    );
  });

  it('빈 원장은 조용한 것이지 고장난 것이 아니다', async () => {
    installFetch({approvals: () => jsonResponse(200, {approvals: []})});
    await openInbox();
    await waitFor(() => expect(screen.getByTestId('inbox-empty')).toBeTruthy());
    expect(screen.getByTestId('inbox-empty')).toHaveTextContent(
      /지금 결정할 일이 없습니다/,
    );
  });

  it('원장을 못 읽으면 다시 시도할 자리를 준다', async () => {
    installFetch({
      approvals: () => jsonResponse(500, {error: {message: 'boom'}}),
    });
    await openInbox();
    await waitFor(() => expect(screen.getByTestId('inbox-error')).toBeTruthy());
    // 서버 영어가 화면에 새지 않는다.
    expect(screen.queryByText(/boom/)).toBeNull();
    expect(screen.getByTestId('inbox-error-retry')).toBeTruthy();
  });

  it('서버가 승인을 싣지 않으면 탭도 컨트롤도 세우지 않는다 (fail-closed)', async () => {
    mockApprovalsProvided = false;
    const fixture = installFetch();
    await openInbox();
    await waitFor(() => expect(screen.getByTestId('approvals-absent')).toBeTruthy());
    expect(screen.getByTestId('approvals-absent')).toHaveTextContent(
      /아직 승인 결정을 기록하지 않습니다/,
    );
    // 탭이 하나뿐이면 탭 줄이 없다.
    expect(screen.queryByTestId('inbox-tab-needs-action')).toBeNull();
    // 그리고 원장을 부르지조차 않는다: 없는 경로의 404를 받아 놓고 "결정할 것이
    // 없다"로 세는 것이 이 게이트가 막는 일이다.
    expect(
      fixture.fetch.mock.calls.some(([url]) => String(url).includes('/approvals')),
    ).toBe(false);
  });
});

// ---- 결정 3분기 ------------------------------------------------------------

describe('결정의 세 갈래', () => {
  it('승인이 기록되면 원장이 답한 그대로 말하고 목록을 다시 읽는다', async () => {
    let page = 0;
    const fixture = installFetch({
      approvals: status => {
        if (status !== 'pending') return jsonResponse(200, {approvals: []});
        page += 1;
        // 결정 뒤의 재조회는 서버가 답한 새 상태다. 행이 사라지는 것도 서버의
        // 답이지 이 클라이언트가 숨긴 것이 아니다.
        return jsonResponse(200, {approvals: page === 1 ? [wireApproval()] : []});
      },
    });
    const row = await openPendingRow();

    expect(within(row).getByTestId(`inbox-approval-${PENDING}-approve`)).toBeTruthy();
    armAndCommit(PENDING, 'approve');

    await waitFor(() =>
      expect(screen.getByTestId('inbox-decision-note')).toHaveTextContent(
        /승인했습니다\. 에이전트가 이어서 실행합니다\./,
      ),
    );
    expect(fixture.decisions()).toEqual([
      {approvalId: PENDING, approve: true, key: expect.any(String)},
    ]);
    // 원장을 다시 읽었고, 결정된 행은 대기 목록에서 사라졌다.
    await waitFor(() =>
      expect(screen.queryByTestId(`feed-row-approval:${PENDING}`)).toBeNull(),
    );
    expect(page).toBeGreaterThan(1);
  });

  it('보내지 못하면 실패를 말하고 행을 그대로 둔다 — 같은 키로 재시도한다', async () => {
    let attempts = 0;
    const fixture = installFetch({
      decision: (approvalId, body) => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse(503, {error: {message: 'upstream down'}})
          : jsonResponse(200, {
              approval_id: approvalId,
              status: body.approve ? 'approved' : 'rejected',
              decided_by: SELF_ID,
              decided_at_ms: 1_700_000_000_000,
            });
      },
    });
    const row = await openPendingRow();

    expect(within(row).getByTestId(`inbox-approval-${PENDING}-reject`)).toBeTruthy();
    armAndCommit(PENDING, 'reject');
    await waitFor(() =>
      expect(screen.getByTestId(`inbox-approval-${PENDING}-error`)).toBeTruthy(),
    );
    expect(screen.getByTestId(`inbox-approval-${PENDING}-error`)).toHaveTextContent(
      /503/,
    );
    // 실패했으므로 결정된 척하지 않는다: 확정 버튼도 행도 그대로 있다.
    expect(screen.queryByTestId('inbox-decision-note')).toBeNull();
    expect(screen.getByTestId(`feed-row-approval:${PENDING}`)).toBeTruthy();

    fireEvent.press(screen.getByTestId(`inbox-approval-${PENDING}-commit`));
    await waitFor(() =>
      expect(screen.getByTestId('inbox-decision-note')).toHaveTextContent(
        /거부했습니다\. 이 실행은 취소되었습니다\./,
      ),
    );
    // 재시도는 **같은 멱등키**로 나갔다. 새 키였다면 서버 쪽에서 두 번째 결정이
    // 되고, 첫 요청이 실은 도착해 있었을 때 같은 승인이 두 번 기록된다.
    const sent = fixture.decisions();
    expect(sent).toHaveLength(2);
    expect(sent[0].key).toBe(sent[1].key);
    expect(sent.every(entry => entry.approve === false)).toBe(true);
  });

  it('이미 결정된 것은 오류가 아니라 "이미 결정됨"이다 (superseded)', async () => {
    // 잠금화면에서 먼저 눌렀거나 다른 기기에서 결정했다. 서버는 409에 확정된
    // 상태를 실어 답하고, 그것은 정상적인 상태 전이다
    // (`src/push/notifications.ts:142`가 같은 답을 같은 뜻으로 읽는다).
    installFetch({
      decision: approvalId =>
        jsonResponse(409, {
          approval_id: approvalId,
          status: 'approved',
          decided_by: SELF_ID,
          decided_at_ms: 1_700_000_000_000,
        }),
    });
    const row = await openPendingRow();

    expect(within(row).getByTestId(`inbox-approval-${PENDING}-approve`)).toBeTruthy();
    armAndCommit(PENDING, 'approve');

    await waitFor(() =>
      expect(screen.getByTestId('inbox-decision-note')).toHaveTextContent(
        /다른 곳에서 이미 결정되었습니다\./,
      ),
    );
    // 실패로 그리지 않는다 — 더는 바뀔 수 없는 것에 재시도를 권하지 않기 위해.
    expect(screen.queryByTestId(`inbox-approval-${PENDING}-error`)).toBeNull();
  });

  it('멱등 충돌이면 그 키를 버리고 새 키로 재시도한다', async () => {
    // 서버가 그 키를 **다른** 결정에 묶어 두고 있다. 같은 키로 다시 보내면 같은
    // 충돌만 반복되므로, core가 그 갈래에만 `idempotency_conflict`를 실어 준다.
    let attempts = 0;
    const fixture = installFetch({
      decision: approvalId => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse(409, {approval_id: approvalId, status: 'pending'})
          : jsonResponse(200, {
              approval_id: approvalId,
              status: 'approved',
              decided_by: SELF_ID,
              decided_at_ms: 1_700_000_000_000,
            });
      },
    });
    const row = await openPendingRow();

    expect(within(row).getByTestId(`inbox-approval-${PENDING}-approve`)).toBeTruthy();
    armAndCommit(PENDING, 'approve');
    await waitFor(() =>
      expect(screen.getByTestId(`inbox-approval-${PENDING}-error`)).toHaveTextContent(
        /다른 결정으로 기록되어 있습니다/,
      ),
    );

    fireEvent.press(screen.getByTestId(`inbox-approval-${PENDING}-commit`));
    await waitFor(() => expect(fixture.decisions()).toHaveLength(2));
    const sent = fixture.decisions();
    expect(sent[0].key).not.toBe(sent[1].key);
  });
});

// ---- red proof ①: 확인 없이 결정되는 경로가 없다 ---------------------------

describe('RED PROOF ①: 확인 단계를 건너뛰는 경로가 없다', () => {
  it('행 안의 어떤 것을 눌러도 확인 전에는 결정이 전송되지 않는다', async () => {
    // 승인/거부를 한 번씩 누르는 것으로는 부족하다 — 다음 배치가 행에 새 컨트롤을
    // 하나 더 붙이고 그것이 즉발이면, 좁은 단언은 그대로 초록으로 남는다. 그래서
    // 행 안의 **모든** 누를 수 있는 것을, 시간을 흘리지 않고 잇달아 누른다.
    // 이것이 사람의 손에서 일어나는 모습은 이렇다: 승인을 누르고, 그 자리에 뜬
    // 확정 버튼을 같은 동작의 두 번째 탭이 그대로 때린다.
    //
    // **이 단언은 실제로 결함을 잡았다.** 처음 구현에서는 이 sweep이 결정 하나를
    // 전송했다 — 확인 단계는 있었지만 확정 버튼이 방금 누른 버튼 자리에 떠서,
    // 빠른 두 번 탭이 그것을 통째로 건너뛰었다. 그래서 `CONFIRM_GUARD_MS`가 있다.
    const fixture = installFetch();
    const row = await openPendingRow();

    for (const button of within(row).getAllByRole('button')) {
      fireEvent.press(button);
    }
    // 확인 컨트롤이 떠 있을 뿐, 원장에는 아무것도 가지 않았다.
    expect(fixture.decisions()).toHaveLength(0);
    expect(
      fixture.fetch.mock.calls.some(([url]) => String(url).includes('/decision')),
    ).toBe(false);

    // 그리고 사람이 문장을 읽고 누르면 정확히 한 번 나간다.
    elapse(CONFIRM_GUARD_MS + 100);
    fireEvent.press(screen.getByTestId(`inbox-approval-${PENDING}-commit`));
    await waitFor(() => expect(fixture.decisions()).toHaveLength(1));
  });

  it('확정 버튼이 뜬 직후의 탭은 확인이 아니다 (더블탭 구멍)', async () => {
    // 위 sweep을 사람 손의 모양 그대로 좁혀 놓은 것. 같은 지점을 두 번 빠르게
    // 때리는 것으로 되돌릴 수 없는 행동이 실행되면 안 된다.
    const fixture = installFetch();
    const row = await openPendingRow();

    fireEvent.press(within(row).getByTestId(`inbox-approval-${PENDING}-approve`));
    elapse(CONFIRM_GUARD_MS - 100);
    fireEvent.press(screen.getByTestId(`inbox-approval-${PENDING}-commit`));
    expect(fixture.decisions()).toHaveLength(0);
    // 컨트롤은 죽지 않았다 — 잠깐 뒤의 같은 탭은 결정한다.
    expect(screen.getByTestId(`inbox-approval-${PENDING}-confirm`)).toBeTruthy();

    elapse(200);
    fireEvent.press(screen.getByTestId(`inbox-approval-${PENDING}-commit`));
    await waitFor(() => expect(fixture.decisions()).toHaveLength(1));
  });

  it('취소하면 아무 일도 일어나지 않은 상태로 돌아간다', async () => {
    const fixture = installFetch();
    const row = await openPendingRow();

    fireEvent.press(within(row).getByTestId(`inbox-approval-${PENDING}-approve`));
    fireEvent.press(screen.getByTestId(`inbox-approval-${PENDING}-cancel`));

    expect(screen.getByTestId(`inbox-approval-${PENDING}-actions`)).toBeTruthy();
    expect(screen.queryByTestId(`inbox-approval-${PENDING}-confirm`)).toBeNull();
    expect(fixture.decisions()).toHaveLength(0);
  });

  it('확인 문장은 무엇이 일어나는지 말하고, 되돌릴 수 없으면 그것도 말한다', async () => {
    installFetch({
      approvals: status =>
        jsonResponse(200, {
          approvals:
            status === 'pending'
              ? [wireApproval({id: IRREVERSIBLE, is_reversible: false})]
              : [],
        }),
    });
    const row = await openPendingRow(IRREVERSIBLE);
    // 행은 core가 쓴 대로 이미 되돌릴 수 없음을 이고 있다.
    expect(row).toHaveTextContent(/되돌릴 수 없음/);

    fireEvent.press(within(row).getByTestId(`inbox-approval-${IRREVERSIBLE}-approve`));
    expect(screen.getByTestId(`inbox-approval-${IRREVERSIBLE}-confirm`)).toHaveTextContent(
      /승인하면 에이전트가 바로 실행합니다\. 되돌릴 수 없습니다\./,
    );
  });

  it('보내는 중에는 두 번째 요청이 나가지 않는다', async () => {
    let release: (() => void) | null = null;
    const fixture = installFetch({
      decision: approvalId =>
        new Promise<Response>(resolve => {
          release = () =>
            resolve(
              jsonResponse(200, {
                approval_id: approvalId,
                status: 'approved',
                decided_by: SELF_ID,
                decided_at_ms: 1_700_000_000_000,
              }),
            );
        }),
    });
    await openPendingRow();

    armAndCommit(PENDING, 'approve');
    // 답이 아직 붙잡혀 있는 동안: 버튼은 "보내는 중"이고, 다시 눌러도 조용하다.
    await waitFor(() =>
      expect(screen.getByTestId(`inbox-approval-${PENDING}-commit`)).toHaveTextContent(
        '보내는 중',
      ),
    );
    fireEvent.press(screen.getByTestId(`inbox-approval-${PENDING}-commit`));
    expect(fixture.decisions()).toHaveLength(1);

    release!();
    await waitFor(() => expect(screen.getByTestId('inbox-decision-note')).toBeTruthy());
    expect(fixture.decisions()).toHaveLength(1);
  });

  it('무장 사실을 화면을 보지 않는 사람에게도 알린다', async () => {
    // RN에는 웹처럼 확정 버튼으로 포커스를 옮길 방법이 없다. 엄지 밑의 버튼이
    // 의미를 바꿨다는 사실이 소리로 전달되지 않으면 VoiceOver 사용자는 승인
    // 버튼이라고 믿고 같은 자리를 다시 누른다.
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => {});
    installFetch();
    const row = await openPendingRow();

    fireEvent.press(within(row).getByTestId(`inbox-approval-${PENDING}-approve`));
    expect(announce).toHaveBeenCalledWith('승인을 확정할지 묻습니다.');
  });
});

// ---- red proof ②: 결정할 수 없는 행에는 컨트롤이 없다 ----------------------

describe('RED PROOF ②: pending 아닌 항목에는 결정 컨트롤이 없다', () => {
  it('이미 결정된 승인이 대기 페이지에 섞여 와도 컨트롤을 세우지 않는다', async () => {
    // 방금 다른 기기에서 결정된 행이 대기 페이지에 남아 오는 경우다. core는
    // `approvalId`를 대기 행에만 싣고(model.ts:152), 화면은 그것이 없으면 결정할
    // 대상이 없다고 읽는다.
    installFetch({
      approvals: status =>
        jsonResponse(200, {
          approvals:
            status === 'pending'
              ? [
                  wireApproval(),
                  wireApproval({
                    id: SETTLED,
                    status: 'approved',
                    decided_by: SELF_ID,
                    decided_at_ms: 1_700_000_000_000,
                  }),
                ]
              : [],
        }),
    });
    const pending = await openPendingRow();
    const settled = screen.getByTestId(`feed-row-approval:${SETTLED}`);
    expect(settled).toHaveTextContent(/승인됨/);
    // **test id가 아니라 라벨로 묻는다.** id는 `approvalId`에서 나오므로, 게이트가
    // 사라져 컨트롤이 id 없이 그려지면 id로 묻는 단언은 그것을 못 보고 초록으로
    // 남는다 (이 파일을 쓰면서 실제로 그 구멍에 한 번 빠졌다). 사람이 보는 것은
    // 라벨이고, 이 행에 「승인」이라고 적힌 버튼이 있으면 그것이 결함이다.
    expect(within(settled).queryByLabelText('승인')).toBeNull();
    expect(within(settled).queryByLabelText('거부')).toBeNull();
    expect(within(settled).queryAllByRole('button')).toHaveLength(1); // 행 본문뿐
    // 그리고 대기 행에는 여전히 있다 — 이 단언이 없으면 위의 부재는 "아무 컨트롤도
    // 안 그렸다"로도 참이 된다.
    expect(within(pending).getByLabelText('승인')).toBeTruthy();
    expect(within(pending).getByLabelText('거부')).toBeTruthy();
  });

  it('에이전트 탭에서는 결정하지 않고, 어디서 하는지만 말한다', async () => {
    installFetch({
      approvals: status =>
        jsonResponse(200, {
          approvals: status === 'pending' ? [wireApproval()] : [],
        }),
    });
    await openPendingRow();
    fireEvent.press(screen.getByTestId('inbox-tab-agents'));

    await waitFor(() =>
      expect(
        screen.getByTestId(`decision-elsewhere-approval:${PENDING}`),
      ).toHaveTextContent(/결정 대기 탭에서 승인하거나 거부할 수 있습니다\./),
    );
    const row = screen.getByTestId(`feed-row-approval:${PENDING}`);
    expect(within(row).queryByLabelText('승인')).toBeNull();
    expect(within(row).queryByLabelText('거부')).toBeNull();
  });

  it('서버가 승인을 싣지 않는 빌드에서는 데스크톱을 가리킨다', async () => {
    // fail-closed 경로가 사라지지 않았다는 증거. 이 빌드에서는 탭 자체가 없어
    // 대기 목록에 닿을 수 없지만, 판정이 뒤집히는 날 남는 것은 이 문장이 아니라
    // 컨트롤이어야 하고, 그 전까지는 이 문장이어야 한다.
    mockApprovalsProvided = false;
    installFetch();
    await openInbox();
    await waitFor(() => expect(screen.getByTestId('approvals-absent')).toBeTruthy());
    expect(screen.queryByLabelText('승인')).toBeNull();
    expect(screen.queryByLabelText('거부')).toBeNull();
  });
});

// ---- 연결이 끊겼을 때 ------------------------------------------------------

describe('오프라인', () => {
  it('버튼을 남겨 두지도, 말없이 치우지도 않는다', async () => {
    const netInfo = jest.requireMock('@react-native-community/netinfo').default as {
      __emit: (state: {
        isConnected: boolean | null;
        isInternetReachable: boolean | null;
      }) => void;
    };
    installFetch();
    const row = await openPendingRow();
    expect(within(row).getByTestId(`inbox-approval-${PENDING}-approve`)).toBeTruthy();

    // NetInfo는 React 밖에서 부르는 리스너다 — 화면의 `setOnline`이 그 안에서
    // 일어나므로 emit 자체를 `act`로 감싼다.
    act(() => {
      netInfo.__emit({isConnected: false, isInternetReachable: false});
    });

    await waitFor(() =>
      expect(
        screen.getByTestId(`decision-offline-approval:${PENDING}`),
      ).toHaveTextContent(/연결이 끊겨 지금은 결정할 수 없습니다/),
    );
    expect(screen.queryByTestId(`inbox-approval-${PENDING}-approve`)).toBeNull();
  });
});
