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
const REVERSIBLE = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
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

/**
 * `GET …/approvals` 한 행 — **이 서버가 실제로 보내는 모양** (2R H1).
 *
 * 1R의 픽스처는 `action_type: 'work.spawn'` + `is_reversible: true`였다. 그 두 값은
 * 이 서버가 **한 번도 보내지 않는다**. 서버가 실을 수 있는 것은 이것뿐이다:
 *
 *   * 키는 camelCase — `bins/momo-server/src/dto.rs:2213`의 `ApprovalDto`가
 *     `#[serde(rename_all = "camelCase")]`다. (정본 스펙 `docs/api/openapi.yaml`의
 *     `ApprovalProjection`은 snake_case를 적고 있어 둘이 어긋난다 — PR 이탈 참조.
 *     그래서 아래에 snake_case 픽스처도 따로 둔다: 클라이언트는 두 서버를 다 만난다.)
 *   * `actionType`은 언제나 `'tool_call'` (`crates/momo-agent/src/tools.rs:82`).
 *   * `isReversible`은 **없다**. dto.rs:2210-2212가 명시한다 — 없음은 "모른다"이지
 *     "되돌릴 수 있다"가 아니다. v0의 유일한 툴 `work.session.end`는 비가역인 것이
 *     선정 사유다(tools.rs:33-38).
 *   * 툴 이름은 `payload.tool_call.name`에 있다 (`approval.rs:566-590`의
 *     `approval_payload` 실측).
 *
 * 픽스처가 서버보다 친절하면 화면의 거짓말이 테스트에 잠긴다(#980의 교훈).
 */
function wireApproval(over: Record<string, unknown> = {}) {
  return {
    id: PENDING,
    workspaceId: WS,
    runId: 'run-1',
    channelId: CHANNEL,
    requestedBy: KIM_AGENT,
    actionType: 'tool_call',
    payload: {
      run_id: 'run-1',
      action_type: 'tool_call',
      tool_call: {
        call_id: 'call-1',
        name: 'work.session.end',
        arguments: '{"session_id":"SESSION-APP"}',
        arguments_json: {session_id: 'SESSION-APP'},
      },
      approval_reason: 'irreversible tool',
      resume_model: 'gpt-5.6',
    },
    status: 'pending',
    expiresAtMs: 1_700_000_600_000,
    createdAtMs: 1_699_999_000_000,
    ...over,
  };
}

/** 같은 행을 정본 스펙(`openapi.yaml` ApprovalProjection)의 snake_case로. */
function wireApprovalSnake(over: Record<string, unknown> = {}) {
  const camel = wireApproval(over);
  return {
    id: camel.id,
    workspace_id: camel.workspaceId,
    run_id: camel.runId,
    channel_id: camel.channelId,
    requested_by: camel.requestedBy,
    action_type: camel.actionType,
    payload: camel.payload,
    status: camel.status,
    expires_at_ms: camel.expiresAtMs,
    created_at_ms: camel.createdAtMs,
    ...over,
  };
}

/**
 * `POST …/approvals/{id}/decision`의 영수증 — 역시 camelCase다
 * (`dto.rs:2266`의 `ApprovalDecisionReceipt`). core의 영수증 파서는 snake_case를
 * 읽으므로 `decidedBy`/`decidedAtMs`는 지금 버려진다 — `status`만 두 표기가 같아
 * 결정 자체는 성립한다. 그 어긋남은 `approvalDecision.ts`(W-2R 전속)의 몫이라
 * 여기서는 서버가 보내는 그대로 두고 PR 이탈에 적는다.
 */
function receipt(approvalId: string, status: string) {
  return {
    approvalId,
    status,
    decidedBy: SELF_ID,
    decidedAtMs: 1_700_000_000_000,
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
        : jsonResponse(200, receipt(approvalId, body.approve ? 'approved' : 'rejected'));
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
        /승인을 기록했습니다\./,
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
          : jsonResponse(200, receipt(approvalId, body.approve ? 'approved' : 'rejected'));
      },
    });
    const row = await openPendingRow();

    expect(within(row).getByTestId(`inbox-approval-${PENDING}-reject`)).toBeTruthy();
    armAndCommit(PENDING, 'reject');
    await waitFor(() =>
      expect(screen.getByTestId(`inbox-approval-${PENDING}-error`)).toBeTruthy(),
    );
    // W-2R M5 이후 상태 코드는 문구에 없다. 사람에게 503은 할 말이 아니고,
    // 할 말은 "무엇이 일어났고 다음에 뭘 하면 되는가"다.
    expect(screen.getByTestId(`inbox-approval-${PENDING}-error`)).toHaveTextContent(
      /서버가 오류로 답했습니다/,
    );
    expect(screen.queryByText(/503/)).toBeNull();
    // 실패했으므로 결정된 척하지 않는다: 확정 버튼도 행도 그대로 있다.
    expect(screen.queryByTestId('inbox-decision-note')).toBeNull();
    expect(screen.getByTestId(`feed-row-approval:${PENDING}`)).toBeTruthy();

    fireEvent.press(screen.getByTestId(`inbox-approval-${PENDING}-commit`));
    // 행이 아직 목록에 있으므로 답은 그 행 자리에 남는다 (2R H3).
    await waitFor(() =>
      expect(
        screen.getByTestId(`decision-receipt-approval:${PENDING}`),
      ).toHaveTextContent(/거부를 기록했습니다\./),
    );
    // 답이 있는 자리에는 컨트롤이 없다 — 끝난 결정을 다시 누를 자리를 남기지 않는다.
    expect(screen.queryByTestId(`inbox-approval-${PENDING}-commit`)).toBeNull();
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
      decision: approvalId => jsonResponse(409, receipt(approvalId, 'approved')),
    });
    const row = await openPendingRow();

    expect(within(row).getByTestId(`inbox-approval-${PENDING}-approve`)).toBeTruthy();
    armAndCommit(PENDING, 'approve');

    // M3: **원장에 실제로 적힌 방향**을 말한다. 내가 승인을 눌렀어도 원장이
    // 거부를 답할 수 있고, 그때 "이미 결정되었습니다"만 말하면 사람은 자기가 누른
    // 대로 됐다고 읽는다.
    await waitFor(() =>
      expect(
        screen.getByTestId(`decision-receipt-approval:${PENDING}`),
      ).toHaveTextContent(/이미 승인으로 기록되어 있었습니다\./),
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
          ? jsonResponse(409, receipt(approvalId, 'pending'))
          : jsonResponse(200, receipt(approvalId, 'approved'));
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

// ---- 2R red proof: 컨트롤이 하는 「말」이 참인가 ----------------------------
//
// 1R 리뷰의 판정: 컨트롤(확인 단계·가드·멱등키)은 견고한데 그것이 하는 말이
// 무너진다. 아래 두 묶음이 그 말을 못박는다. 둘 다 **서버가 실제로 보내는
// 픽스처**(위 `wireApproval`) 위에서만 의미가 있다 — 친절한 픽스처는 거짓말을
// 잠근다.

describe('RED PROOF ③: 서버가 가역이라고 말하지 않았으면 가역이라고 말하지 않는다', () => {
  it('필드가 없으면 「되돌릴 수 없음」 — absent는 unknown이지 reversible이 아니다', async () => {
    // 계약: dto.rs:2210-2212 "A client must treat an absent isReversible as
    // unknown, never as reversible." v0의 유일한 툴은 비가역인 것이 선정 사유다.
    installFetch();
    const row = await openPendingRow();
    expect(row).toHaveTextContent(/되돌릴 수 없음/);

    fireEvent.press(within(row).getByTestId(`inbox-approval-${PENDING}-approve`));
    // 확정 문장이 그 사실을 다시 말한다. 경고를 행에만 두면 확인 화면에서
    // 사라지고, 사람이 마지막으로 읽는 문장이 가장 조용해진다.
    expect(screen.getByTestId(`inbox-approval-${PENDING}-confirm`)).toHaveTextContent(
      /되돌릴 수 없습니다\./,
    );
  });

  it('서버가 명시적으로 true라고 말한 행에서만 그 경고가 없다', async () => {
    installFetch({
      approvals: status =>
        jsonResponse(200, {
          approvals:
            status === 'pending'
              ? [wireApproval({id: REVERSIBLE, isReversible: true})]
              : [],
        }),
    });
    const row = await openPendingRow(REVERSIBLE);
    expect(row).not.toHaveTextContent(/되돌릴 수 없음/);

    fireEvent.press(within(row).getByTestId(`inbox-approval-${REVERSIBLE}-approve`));
    expect(
      screen.getByTestId(`inbox-approval-${REVERSIBLE}-confirm`),
    ).not.toHaveTextContent(/되돌릴 수 없습니다/);
  });
});

describe('RED PROOF ④: 내부 식별자가 사람 문장에 새지 않는다', () => {
  it('행 제목이 `tool_call`이 아니라 그 툴이 하는 일이다', async () => {
    // 서버가 보내는 유일한 action_type은 `tool_call`이고(tools.rs:82), 그것은
    // 승인 원장의 계층 이름이지 사람에게 할 말이 아니다. 무엇을 허가하는지는
    // `payload.tool_call.name`에 있다.
    installFetch();
    const row = await openPendingRow();
    expect(row).toHaveTextContent(/작업 세션 종료 허가를 요청했습니다/);
    expect(row).not.toHaveTextContent(/tool_call/);
    // 화면 어디에도 없어야 한다 — 행 밖으로 새는 경로(접근성 라벨 포함)까지.
    expect(screen.queryByText(/tool_call/)).toBeNull();
    expect(screen.queryByLabelText(/tool_call/)).toBeNull();
  });

  it('모르는 툴이면 툴 이름을 그대로 보여준다 — 지어내지도, 계층 이름을 쓰지도 않는다', async () => {
    installFetch({
      approvals: status =>
        jsonResponse(200, {
          approvals:
            status === 'pending'
              ? [
                  wireApproval({
                    payload: {
                      run_id: 'run-1',
                      action_type: 'tool_call',
                      tool_call: {call_id: 'call-9', name: 'repo.branch.delete'},
                    },
                  }),
                ]
              : [],
        }),
    });
    const row = await openPendingRow();
    expect(row).toHaveTextContent(/repo\.branch\.delete/);
    expect(row).not.toHaveTextContent(/tool_call/);
  });

  it('툴 이름조차 없으면 그 사실에 맞는 문장을 쓴다', async () => {
    installFetch({
      approvals: status =>
        jsonResponse(200, {
          approvals:
            status === 'pending' ? [wireApproval({payload: {run_id: 'run-1'}})] : [],
        }),
    });
    const row = await openPendingRow();
    expect(row).toHaveTextContent(/에이전트 도구 실행 허가를 요청했습니다/);
    expect(row).not.toHaveTextContent(/tool_call/);
  });
});

describe('두 서버의 표기를 모두 읽는다', () => {
  it('정본 스펙의 snake_case 행도 같은 문장으로 그린다', async () => {
    // `docs/api/openapi.yaml`의 ApprovalProjection은 snake_case이고 Rust 서버의
    // ApprovalDto는 camelCase다. 클라이언트 하나가 둘을 다 만나므로, 한쪽만 읽는
    // 파서는 다른 쪽 서버에서 인박스를 통째로 비워 놓는다 — 그리고 빈 목록은
    // 「결정할 것이 없다」로 읽힌다.
    installFetch({
      approvals: status =>
        jsonResponse(200, {
          approvals: status === 'pending' ? [wireApprovalSnake()] : [],
        }),
    });
    const row = await openPendingRow();
    expect(row).toHaveTextContent(/작업 세션 종료 허가를 요청했습니다/);
    expect(row).toHaveTextContent(/되돌릴 수 없음/);
    expect(within(row).getByLabelText('승인, 확인 필요')).toBeTruthy();
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
    // 그리고 조용히 삼키지 않는다 (2R M1): 아무 일도 없는 버튼은 고장난 버튼과
    // 구별되지 않고, 그 다음에 사람이 하는 일은 더 세게 두 번 누르는 것이다.
    expect(
      screen.getByTestId(`inbox-approval-${PENDING}-too-fast`),
    ).toHaveTextContent(/보내지 않았습니다/);

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

  it('확인 문장은 무엇이 일어나는지 말한다 — 서버가 약속하지 못하는 것은 빼고', async () => {
    // 「바로/이어서 실행합니다」는 계약상 못 지키는 약속이었다(2R H4): 승인은
    // run이 hold를 떠났으면 resume job 없이 200을 답하고(approvals.rs
    // `approve_run`의 `requeue…` 가드), 정상 경로도 outbox 비동기다. 그래서
    // 문장은 조건 없이 참인 것만 말한다.
    installFetch();
    const row = await openPendingRow();

    fireEvent.press(within(row).getByTestId(`inbox-approval-${PENDING}-approve`));
    const confirm = screen.getByTestId(`inbox-approval-${PENDING}-confirm`);
    expect(confirm).toHaveTextContent(/승인하면 에이전트가 이어서 진행합니다\./);
    expect(confirm).not.toHaveTextContent(/바로 실행/);

    fireEvent.press(screen.getByTestId(`inbox-approval-${PENDING}-cancel`));
    fireEvent.press(screen.getByTestId(`inbox-approval-${PENDING}-reject`));
    // 거부→취소는 결정과 **같은 트랜잭션**이다(approvals.rs `reject_run` →
    // `end_parked_run_in_tx`). 다만 이미 hold를 떠난 run은 취소할 것이 없으므로
    // 문장은 「대기 중인 실행」으로 한정한다.
    expect(screen.getByTestId(`inbox-approval-${PENDING}-confirm`)).toHaveTextContent(
      /거부하면 대기 중인 실행이 취소됩니다\./,
    );
  });

  it('보내는 중에는 두 번째 요청이 나가지 않는다', async () => {
    let release: (() => void) | null = null;
    const fixture = installFetch({
      decision: approvalId =>
        new Promise<Response>(resolve => {
          release = () => resolve(jsonResponse(200, receipt(approvalId, 'approved')));
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
    await waitFor(() =>
      expect(
        screen.getByTestId(`decision-receipt-approval:${PENDING}`),
      ).toBeTruthy(),
    );
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

describe('기한이 지난 요청 (2R M4)', () => {
  it('확정 문장이 승인도 거부도 아닌 만료를 말한다', async () => {
    // 서버는 기한 뒤에 도착한 클릭을 **만료로 확정**한다(approvals.rs:584
    // `settle_expired` — 409 + status expired). "승인하면 …"은 일어나지 않을 일이다.
    installFetch({
      approvals: status =>
        jsonResponse(200, {
          approvals:
            status === 'pending'
              ? [wireApproval({expiresAtMs: nowMs - 60_000})]
              : [],
        }),
    });
    const row = await openPendingRow();
    expect(row).toHaveTextContent(/기한 지남/);

    fireEvent.press(within(row).getByTestId(`inbox-approval-${PENDING}-approve`));
    const confirm = screen.getByTestId(`inbox-approval-${PENDING}-confirm`);
    expect(confirm).toHaveTextContent(
      /기한이 지난 요청입니다\. 지금 보내면 승인도 거부도 아닌 만료로 기록됩니다\./,
    );
    expect(confirm).not.toHaveTextContent(/이어서 진행/);
  });

  it('만료로 확정된 영수증은 만료라고 말한다', async () => {
    installFetch({
      approvals: status =>
        jsonResponse(200, {
          approvals:
            status === 'pending'
              ? [wireApproval({expiresAtMs: nowMs - 60_000})]
              : [],
        }),
      decision: approvalId => jsonResponse(409, receipt(approvalId, 'expired')),
    });
    await openPendingRow();
    armAndCommit(PENDING, 'approve');
    await waitFor(() =>
      expect(
        screen.getByTestId(`decision-receipt-approval:${PENDING}`),
      ).toHaveTextContent(/결정 전에 만료되어 만료로 기록되었습니다\./),
    );
  });
});

describe('영수증 (2R H3/M6)', () => {
  it('두 번째 결정이 첫 번째 답을 덮어쓰지 않는다', async () => {
    const SECOND = 'dddddddd-1111-4111-8111-dddddddddddd';
    installFetch({
      approvals: status =>
        jsonResponse(200, {
          approvals:
            status === 'pending'
              ? [wireApproval(), wireApproval({id: SECOND})]
              : [],
        }),
      decision: (approvalId, body) =>
        jsonResponse(200, receipt(approvalId, body.approve ? 'approved' : 'rejected')),
    });
    await openPendingRow();

    armAndCommit(PENDING, 'approve');
    await waitFor(() =>
      expect(
        screen.getByTestId(`decision-receipt-approval:${PENDING}`),
      ).toHaveTextContent(/승인을 기록했습니다\./),
    );
    armAndCommit(SECOND, 'reject');
    await waitFor(() =>
      expect(
        screen.getByTestId(`decision-receipt-approval:${SECOND}`),
      ).toHaveTextContent(/거부를 기록했습니다\./),
    );
    // 첫 번째 답은 그대로 있다. 1R은 한 칸을 덮어써서 하나를 잃었다.
    expect(
      screen.getByTestId(`decision-receipt-approval:${PENDING}`),
    ).toHaveTextContent(/승인을 기록했습니다\./);
  });

  it('행이 목록에서 빠지면 그 답을 위쪽 알림으로 올린다', async () => {
    let page = 0;
    installFetch({
      approvals: status => {
        if (status !== 'pending') return jsonResponse(200, {approvals: []});
        page += 1;
        return jsonResponse(200, {approvals: page === 1 ? [wireApproval()] : []});
      },
    });
    await openPendingRow();
    armAndCommit(PENDING, 'approve');
    await waitFor(() =>
      expect(screen.queryByTestId(`feed-row-approval:${PENDING}`)).toBeNull(),
    );
    // 사라진 것과 답을 못 본 것은 다르다.
    expect(screen.getByTestId('inbox-decision-note')).toHaveTextContent(
      /승인을 기록했습니다\./,
    );
    fireEvent.press(screen.getByTestId('inbox-decision-note-dismiss'));
    expect(screen.queryByTestId('inbox-decision-note')).toBeNull();
  });

  it('결과를 화면을 보지 않는 사람에게도 말한다', async () => {
    // 무장은 알리고 결과는 알리지 않으면, 되돌릴 수 없는 행동이 소리 없이 끝난다.
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => {});
    installFetch();
    await openPendingRow();
    armAndCommit(PENDING, 'approve');
    await waitFor(() =>
      expect(announce).toHaveBeenCalledWith('승인을 기록했습니다.'),
    );
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
                    decidedBy: SELF_ID,
                    decidedAtMs: 1_700_000_000_000,
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
    expect(within(settled).queryByLabelText(/^승인/)).toBeNull();
    expect(within(settled).queryByLabelText(/^거부/)).toBeNull();
    expect(within(settled).queryAllByRole('button')).toHaveLength(1); // 행 본문뿐
    // 그리고 대기 행에는 여전히 있다 — 이 단언이 없으면 위의 부재는 "아무 컨트롤도
    // 안 그렸다"로도 참이 된다.
    expect(within(pending).getByLabelText('승인, 확인 필요')).toBeTruthy();
    expect(within(pending).getByLabelText('거부, 확인 필요')).toBeTruthy();
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
    expect(within(row).queryByLabelText(/^승인/)).toBeNull();
    expect(within(row).queryByLabelText(/^거부/)).toBeNull();
  });

  it('서버가 승인을 싣지 않는 빌드에서는 데스크톱을 가리킨다', async () => {
    // fail-closed 경로가 사라지지 않았다는 증거. 이 빌드에서는 탭 자체가 없어
    // 대기 목록에 닿을 수 없지만, 판정이 뒤집히는 날 남는 것은 이 문장이 아니라
    // 컨트롤이어야 하고, 그 전까지는 이 문장이어야 한다.
    mockApprovalsProvided = false;
    installFetch();
    await openInbox();
    await waitFor(() => expect(screen.getByTestId('approvals-absent')).toBeTruthy());
    expect(screen.queryByLabelText(/^승인/)).toBeNull();
    expect(screen.queryByLabelText(/^거부/)).toBeNull();
  });
});

describe('아직 배포되지 않은 서버 (3R N-A)', () => {
  /** 라우트를 싣지 않은 서버의 404 — 라우터 기본 응답이라 **본문이 없다**. */
  function routeMissing(): Response {
    return {status: 404, ok: false, text: async () => ''} as unknown as Response;
  }

  it('미제공을 장애로 그리지 않는다 — 재시도 버튼도 주지 않는다', async () => {
    // 정적 판정은 W-AP1이 `provided: true`로 뒤집었다(라우트가 코드에 올라갔다).
    // 그러니 아직 배포하지 않은 서버에서는 이 목록이 404를 받는다. 그것을 오류로
    // 세면 화면은 "다시 시도"를 그리고, 다시 시도해도 영영 같은 답이 온다.
    const fixture = installFetch({approvals: () => routeMissing()});
    await openInbox();

    await waitFor(() =>
      expect(screen.getByTestId('inbox-unavailable')).toBeTruthy(),
    );
    expect(screen.getByTestId('inbox-unavailable')).toHaveTextContent(
      /아직 승인 결정을 기록하지 않습니다/,
    );
    // 오류 상태가 아니다: 붉은 문구도, 재시도도 없다.
    expect(screen.queryByTestId('inbox-error')).toBeNull();
    expect(screen.queryByTestId('inbox-unavailable-retry')).toBeNull();
    // 그리고 없는 경로에 두 번 묻지 않는다 — 폰에서 그 왕복은 라디오를 켠다.
    const asked = fixture.fetch.mock.calls.filter(([url]) =>
      String(url).includes('/approvals?status=pending'),
    );
    expect(asked).toHaveLength(1);
  });

  it('그래도 5xx는 장애다 — 미제공으로 접지 않는다', async () => {
    // 반대 방향의 거짓말: 잠깐 아픈 서버를 영영 없는 기능이라고 말하는 것.
    installFetch({approvals: () => jsonResponse(500, {error: {message: 'boom'}})});
    await openInbox();
    await waitFor(() => expect(screen.getByTestId('inbox-error')).toBeTruthy());
    expect(screen.queryByTestId('inbox-unavailable')).toBeNull();
    expect(screen.getByTestId('inbox-error-retry')).toBeTruthy();
  });

  it('이미 받아 둔 행이 있으면 그것을 지우지 않는다', async () => {
    // 캐시된 절반을 감추는 것도 거짓말이다. 첫 응답은 행을 주고, 재조회가 404를
    // 받는 경우 — 목록은 남고 미제공 문구가 목록을 대신하지 않는다.
    let page = 0;
    installFetch({
      approvals: status => {
        if (status !== 'pending') return jsonResponse(200, {approvals: []});
        page += 1;
        return page === 1
          ? jsonResponse(200, {approvals: [wireApproval()]})
          : routeMissing();
      },
    });
    await openPendingRow();
    // 목록이 낡을 만큼 시간을 흘린 뒤 탭을 돌아오면 재조회가 일어난다.
    fireEvent.press(screen.getByTestId('inbox-tab-mentions'));
    elapse(60_000);
    fireEvent.press(screen.getByTestId('inbox-tab-needs-action'));
    await waitFor(() => expect(page).toBeGreaterThan(1));
    expect(screen.getByTestId(`feed-row-approval:${PENDING}`)).toBeTruthy();
  });
});

describe('반쪽 원장인 「에이전트」 탭 (3R N-B)', () => {
  it('작업 기록을 아직 못 본다는 사실을 먼저 말하고, 목록은 남긴다', async () => {
    // 이 탭은 승인 원장과 작업 실행 기록 **두** 원장 위에 서 있는데 이 서버는
    // 뒤의 것을 읽는 경로가 없다(POST 전용 경로라 GET은 405). 그 사실을 삼키면
    // 승인 기록만 담긴 목록을 놓고 "조용한 게 정상"이라 말하게 된다.
    installFetch();
    await openPendingRow();
    fireEvent.press(screen.getByTestId('inbox-tab-agents'));

    await waitFor(() =>
      expect(screen.getByTestId('inbox-agents-partial')).toBeTruthy(),
    );
    expect(screen.getByTestId('inbox-agents-partial')).toHaveTextContent(
      /한 일의 기록을 아직 보여주지 못합니다/,
    );
    expect(screen.getByTestId('inbox-agents-partial')).toHaveTextContent(
      /아래 목록은 승인 기록만 담고 있습니다/,
    );
    // 있는 절반은 그대로 보인다.
    expect(screen.getByTestId(`feed-row-approval:${PENDING}`)).toBeTruthy();
  });

  it('결정 대기 탭에는 그 고지가 없다 — 그 탭은 반쪽이 아니다', async () => {
    installFetch();
    await openPendingRow();
    expect(screen.queryByTestId('inbox-agents-partial')).toBeNull();
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
