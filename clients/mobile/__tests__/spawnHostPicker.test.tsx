import type {Member} from '@momo/core/lib/api';
import {parseExecutionPlan} from '@momo/core/lib/executionPlan';
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
  ApprovalDecision,
  CONFIRM_GUARD_MS,
} from '../src/features/inbox/ApprovalDecision';
import {SessionProvider} from '../src/session/useSession';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// 폰 승인 카드의 호스트 선택기 (ADR-0125 D6-A, 이슈 1114).
//
// ## 무엇을 가짜로 두는가
//
// `fetch`가 무엇을 답했는가, 그것뿐이다. core의 `decideApproval`·`decisionHostId`·
// `preselectedHostId`, 확인 단계와 그 가드, 픽커, 화면은 전부 진짜다. 결정 함수를
// mock하지 않는 것이 이 파일의 값이다: mock하면 "자격 없는 호스트는 전송되지
// 않는다"가 **호출 인자**에 대한 주장으로 약해지는데, 실제로 지켜야 하는 것은
// **그 id가 네트워크에 나가지 않는다**이다. 그래서 아래 단정은 나간 요청의 **본문**을
// 읽는다.
//
// ## RED PROOF 두 개가 여기에 있다 (웹 게이트가 DOM에서 같은 것을 다시 잡는다)
//
//   ① 자격 없는 호스트는 UI에서 선택되지 않고 본문에도 실리지 않는다.
//      제품 소스에서 `disabled={disabled}`를 지우면 「선택 불가 호스트는 선택되지
//      않는다」가, 코어의 `!picked.selectable` 가드를 지우면 「본문에 실리지
//      않는다」가 이름을 부르며 붉어진다.
//   ② 픽커를 손대지 않으면 `hostId` 키가 아예 없다 = 서버가 카드의 기본값을
//      적용한다. 코어의 기본값 비교를 지우면 붉어진다.
//
// 시계는 테스트가 쥔다. 확정 버튼은 뜬 직후 `CONFIRM_GUARD_MS` 동안 탭을 받지
// 않으므로(더블탭이 확인 단계를 건너뛰는 구멍), 실제 시계로는 "읽고 나서 누른 탭"을
// 만들어낼 수 없다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const APPROVAL = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BASE = 'https://api.example.com';

const LOCAL = '00000000-0000-7000-8000-0000000000a1';
const REMOTE = '00000000-0000-7000-8000-0000000000a2';
const DEAD = '00000000-0000-7000-8000-0000000000a3';
const CLOUD = '00000000-0000-7000-8000-0000000000a4';

const SELF: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '곽성재',
  handle: 'seongjae',
};

/**
 * 서버가 실제로 싣는 `execution` (`spawn_execution_object` 실측). 이 픽스처를
 * 서버보다 친절하게 만들지 않는다: snake_case 그대로, `unavailable_reason`까지
 * 그대로. 픽스처가 서버보다 친절하면 화면의 거짓말이 테스트에 잠긴다.
 */
function executionPayload(over: Record<string, unknown> = {}) {
  return {
    execution: {
      kind: 'work_session_spawn',
      tool: 'codex',
      label: '리팩터링',
      requested_host_id: null,
      default_host_id: LOCAL,
      host_candidates: [
        {
          host_id: LOCAL,
          display_name: '내 맥',
          host_type: 'app',
          tier: 'local',
          scope: 'member',
          online: true,
          selectable: true,
          unavailable_reason: null,
        },
        {
          host_id: REMOTE,
          display_name: '팀 VPS',
          host_type: 'workd',
          tier: 'remote',
          scope: 'workspace',
          online: true,
          selectable: true,
          unavailable_reason: null,
        },
        {
          host_id: DEAD,
          display_name: '낡은 맥',
          host_type: 'app',
          tier: 'local',
          scope: 'member',
          online: false,
          selectable: false,
          unavailable_reason: 'offline',
        },
        {
          host_id: CLOUD,
          display_name: 'momo Cloud',
          host_type: 'cloud',
          tier: 'cloud',
          scope: 'workspace',
          online: true,
          selectable: false,
          unavailable_reason: 't3_disabled',
        },
      ],
      ...over,
    },
  };
}

function plan(over: Record<string, unknown> = {}) {
  const parsed = parseExecutionPlan(executionPayload(over));
  if (parsed === null) throw new Error('픽스처가 픽커로 읽히지 않는다');
  return parsed;
}

interface Sent {
  approve: boolean;
  hostId?: string;
  /** 키가 **아예 없었는지**를 재려면 존재 여부를 따로 들어야 한다. */
  carriedHostKey: boolean;
}

function installFetch(): {fetch: jest.Mock; sent: () => Sent[]} {
  const sent: Sent[] = [];
  const mock = jest.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.includes('/decision')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      sent.push({
        approve: body.approve,
        hostId: body.hostId,
        carriedHostKey: Object.prototype.hasOwnProperty.call(body, 'hostId'),
      });
      return {
        status: 200,
        ok: true,
        text: async () =>
          JSON.stringify({
            approvalId: APPROVAL,
            status: body.approve ? 'approved' : 'rejected',
            decidedBy: SELF_ID,
            decidedAtMs: 1_700_000_000_000,
          }),
      } as unknown as Response;
    }
    throw new Error(`unrouted request: ${target}`);
  });
  global.fetch = mock as unknown as typeof fetch;
  return {fetch: mock, sent: () => sent};
}

function mount(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}},
  });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider member={SELF}>{node}</SessionProvider>
    </QueryClientProvider>,
  );
}

/** 무장한 뒤 가드 창을 넘겨 확정한다. 두 탭 사이의 시간은 테스트가 만든다. */
async function armAndCommit(prefix: string) {
  fireEvent.press(screen.getByTestId(`${prefix}-approve`));
  await screen.findByTestId(`${prefix}-confirm`);
  const now = Date.now();
  const spy = jest.spyOn(Date, 'now').mockReturnValue(now + CONFIRM_GUARD_MS + 1);
  await act(async () => {
    fireEvent.press(screen.getByTestId(`${prefix}-commit`));
  });
  spy.mockRestore();
}

beforeEach(async () => {
  __resetSessionStore();
  __resetServerBaseCache();
  await setServerBase(BASE);
  sessionPort.applyLogin({
    accessToken: 'access-token-1',
    refreshToken: 'refresh-token-1',
    realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
    member: SELF,
  });
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

const PREFIX = 'inbox-approval';

describe('픽커가 그리는 것', () => {
  it('자격 없는 호스트도 사유와 함께 선다 — 숨기지 않는다', () => {
    installFetch();
    mount(
      <ApprovalDecision
        approvalId={APPROVAL}
        execution={plan()}
        onSettled={() => {}}
      />,
    );
    // 「왜 내 랩탑을 못 고르지」의 답은 짧은 목록이 아니라 사유가 붙은 줄이다.
    expect(screen.getByText('낡은 맥 (오프라인)')).toBeTruthy();
    // T3 자리 — ADR-0136이 momo Cloud를 꺼 둔 동안의 표기.
    expect(screen.getByText('momo Cloud (준비 중)')).toBeTruthy();
    expect(screen.getByText('내 맥')).toBeTruthy();
  });

  it('카드의 기본값이 찍혀 있다', () => {
    installFetch();
    mount(
      <ApprovalDecision
        approvalId={APPROVAL}
        execution={plan()}
        onSettled={() => {}}
      />,
    );
    expect(
      screen.getByTestId(`${PREFIX}-host-option-${LOCAL}`).props
        .accessibilityState.checked,
    ).toBe(true);
    expect(
      screen.getByTestId(`${PREFIX}-host-option-${REMOTE}`).props
        .accessibilityState.checked,
    ).toBe(false);
  });

  it('픽커가 없는 승인에는 라디오가 아예 서지 않는다', () => {
    installFetch();
    mount(<ApprovalDecision approvalId={APPROVAL} onSettled={() => {}} />);
    expect(screen.queryByTestId(`${PREFIX}-host-group`)).toBeNull();
  });
});

describe('RED PROOF ① — 자격 없는 호스트는 선택되지도 전송되지도 않는다', () => {
  it('오프라인 줄은 눌러도 선택이 옮겨 가지 않는다', () => {
    installFetch();
    mount(
      <ApprovalDecision
        approvalId={APPROVAL}
        execution={plan()}
        onSettled={() => {}}
      />,
    );
    const dead = screen.getByTestId(`${PREFIX}-host-option-${DEAD}`);
    expect(dead.props.accessibilityState.disabled).toBe(true);
    fireEvent.press(dead);
    expect(dead.props.accessibilityState.checked).toBe(false);
    expect(
      screen.getByTestId(`${PREFIX}-host-option-${LOCAL}`).props
        .accessibilityState.checked,
    ).toBe(true);
  });

  it('T3 슬롯도 같다', () => {
    installFetch();
    mount(
      <ApprovalDecision
        approvalId={APPROVAL}
        execution={plan()}
        onSettled={() => {}}
      />,
    );
    const cloud = screen.getByTestId(`${PREFIX}-host-option-${CLOUD}`);
    expect(cloud.props.accessibilityState.disabled).toBe(true);
    fireEvent.press(cloud);
    expect(cloud.props.accessibilityState.checked).toBe(false);
  });

  it('자격 있는 호스트가 하나도 없으면 승인이 막히고 이유가 선다', async () => {
    const fixture = installFetch();
    mount(
      <ApprovalDecision
        approvalId={APPROVAL}
        execution={plan({
          default_host_id: DEAD,
          host_candidates: executionPayload().execution.host_candidates.filter(
            candidate => !candidate.selectable,
          ),
        })}
        onSettled={() => {}}
      />,
    );
    expect(screen.getByTestId(`${PREFIX}-host-blocked`)).toBeTruthy();
    const approve = screen.getByTestId(`${PREFIX}-approve`);
    expect(approve.props.accessibilityState.disabled).toBe(true);
    fireEvent.press(approve);
    // 무장조차 하지 않는다 — 확정 화면이 서면 사람에게 헛걸음을 시키는 것이다.
    expect(screen.queryByTestId(`${PREFIX}-confirm`)).toBeNull();
    expect(fixture.sent()).toHaveLength(0);
    // 거부는 열려 있다: 서버도 거부에는 호스트를 묻지 않는다.
    fireEvent.press(screen.getByTestId(`${PREFIX}-reject`));
    await screen.findByTestId(`${PREFIX}-confirm`);
  });
});

describe('RED PROOF ② — 손대지 않으면 카드의 기본값이 적용된다', () => {
  it('찍힌 그대로 승인하면 본문에 hostId 키가 없다', async () => {
    const fixture = installFetch();
    mount(
      <ApprovalDecision
        approvalId={APPROVAL}
        execution={plan()}
        onSettled={() => {}}
      />,
    );
    await armAndCommit(PREFIX);
    await waitFor(() => expect(fixture.sent()).toHaveLength(1));
    const sent = fixture.sent()[0];
    expect(sent.approve).toBe(true);
    // 키가 `undefined`인 것과 키가 **없는** 것은 서버에서 뜻이 같지만, 화면이
    // 무엇을 주장했는지는 다르다. 없어야 「사람이 고르지 않았다」가 원장에 남는다.
    expect(sent.carriedHostKey).toBe(false);
  });

  it('다른 호스트로 바꾸면 그 id가 실린다', async () => {
    const fixture = installFetch();
    mount(
      <ApprovalDecision
        approvalId={APPROVAL}
        execution={plan()}
        onSettled={() => {}}
      />,
    );
    fireEvent.press(screen.getByTestId(`${PREFIX}-host-option-${REMOTE}`));
    await armAndCommit(PREFIX);
    await waitFor(() => expect(fixture.sent()).toHaveLength(1));
    expect(fixture.sent()[0].hostId).toBe(REMOTE);
  });

  it('거부에는 호스트가 실리지 않는다', async () => {
    const fixture = installFetch();
    mount(
      <ApprovalDecision
        approvalId={APPROVAL}
        execution={plan()}
        onSettled={() => {}}
      />,
    );
    fireEvent.press(screen.getByTestId(`${PREFIX}-host-option-${REMOTE}`));
    fireEvent.press(screen.getByTestId(`${PREFIX}-reject`));
    await screen.findByTestId(`${PREFIX}-confirm`);
    const now = Date.now();
    const spy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(now + CONFIRM_GUARD_MS + 1);
    await act(async () => {
      fireEvent.press(screen.getByTestId(`${PREFIX}-commit`));
    });
    spy.mockRestore();
    await waitFor(() => expect(fixture.sent()).toHaveLength(1));
    expect(fixture.sent()[0].approve).toBe(false);
    expect(fixture.sent()[0].carriedHostKey).toBe(false);
  });
});

describe('확정 문장', () => {
  it('목적지를 말하고, 확정 화면에서 픽커는 잠긴다', async () => {
    installFetch();
    mount(
      <ApprovalDecision
        approvalId={APPROVAL}
        execution={plan()}
        onSettled={() => {}}
      />,
    );
    fireEvent.press(screen.getByTestId(`${PREFIX}-host-option-${REMOTE}`));
    fireEvent.press(screen.getByTestId(`${PREFIX}-approve`));
    await screen.findByTestId(`${PREFIX}-confirm`);
    expect(
      screen.getByText(/「팀 VPS」에서 실행합니다\./),
    ).toBeTruthy();
    // 문장이 목적지를 말한 뒤 그 아래에서 목적지가 바뀌면, 읽은 문장과 나가는
    // 요청이 달라진다.
    expect(
      screen.getByTestId(`${PREFIX}-host-option-${LOCAL}`).props
        .accessibilityState.disabled,
    ).toBe(true);
  });
});
