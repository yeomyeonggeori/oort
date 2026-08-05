import type {Member, Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {cleanup, render, within} from '@testing-library/react-native';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';

import {
  approvalGates,
  deadlinePassed,
  gateFor,
  type ApprovalGate,
} from '../src/features/conversation/approvalGate';
import {pendingApprovalsKey} from '../src/features/conversation/usePendingApprovals';
import {MessageRow} from '../src/features/conversation/MessageRow';
import {SessionProvider} from '../src/session/useSession';

// =============================================================================
// 타임라인 승인 카드 (감사 H-1 / goal U4-g)
//
// 이 파일이 지키는 것은 「버튼이 동작한다」가 아니다 — 그건 인박스 쪽
// `inboxApproval.test.tsx` 가 이미 네트워크까지 내려가 지킨다. 여기서 지키는 것은
// **컨트롤이 언제 서지 않는가**, 그리고 **컨트롤이 설 때 무엇을 근거로 서는가**다.
//
// 이 goal 이 옮긴 것은 컨트롤이지 판단이 아니다. 판단은 코어에 있고, 이 파일은
// 그 판단으로 가는 문 넷이 닫혀 있는지를 센다.
// =============================================================================

const WS = 'ws-1';
const SELF = '11111111-1111-4111-8111-111111111111';
const AGENT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BASE_MS = 1_700_000_000_000;

function approval(over: Record<string, unknown> = {}) {
  return {
    id: 'ap-1',
    workspaceId: WS,
    runId: 'run-1',
    channelId: 'ch',
    requestedBy: AGENT,
    actionType: 'tool_call',
    status: 'pending',
    ...over,
  } as never;
}

function card(over: Record<string, unknown> = {}): Message {
  return {
    id: 'msg-1',
    channelId: 'ch',
    seq: 10,
    hlcTs: 10,
    hlcCount: 0,
    authorMemberId: AGENT,
    type: 'approval_request',
    body: '툴 호출 승인',
    state: 'sent',
    createdAtMs: BASE_MS,
    props: {
      approval_id: 'ap-1',
      title: 'github.search_issues 실행 허가',
      approval_status: 'pending',
      ...over,
    },
  } as unknown as Message;
}

function member(id: string, over: Partial<RosterMember> = {}): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind: id === AGENT ? 'agent' : 'human',
    status: 'active',
    displayName: id === AGENT ? '김인턴' : '곽성재',
    handle: id === AGENT ? 'intern-kim' : 'seongjae',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const DIRECTORY = makeDirectory([member(SELF), member(AGENT)]);
const ME = {id: SELF, workspaceId: WS, displayName: '곽성재'} as Member;

const GATE: ApprovalGate = {
  approvalId: 'ap-1',
  reversible: false,
  expiresAtMs: null,
};

function renderCard(props: {
  message?: Message;
  gates?: ReadonlyMap<string, ApprovalGate>;
  receipts?: ReadonlyMap<string, string>;
}) {
  const client = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}},
  });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider member={ME}>
        <MessageRow
          message={props.message ?? card()}
          startsGroup
          directory={DIRECTORY}
          chips={[]}
          nowMs={BASE_MS}
          approvalGates={props.gates}
          approvalReceipts={props.receipts}
          onApprovalSettled={() => {}}
        />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

const DEAD_END = '이 결정은 인박스나 데스크톱 앱에서 처리할 수 있습니다.';

afterEach(cleanup);

// -----------------------------------------------------------------------------
describe('H-1 — 승인 카드가 더 이상 막다른 길이 아니다', () => {
  it('결정할 수 있으면 컨트롤이 서고, 다른 데로 가라는 문장이 사라진다', () => {
    const view = renderCard({gates: new Map([['ap-1', GATE]])});
    const agentCard = view.getByTestId('agent-card');
    expect(within(agentCard).getByTestId('card-approval-ap-1-actions')).toBeTruthy();
    expect(within(agentCard).getByTestId('card-approval-ap-1-approve')).toBeTruthy();
    expect(within(agentCard).getByTestId('card-approval-ap-1-reject')).toBeTruthy();
    expect(within(agentCard).queryByText(DEAD_END)).toBeNull();
  });

  it('결정할 수 없으면 예전 문장을 그대로 유지한다 — 없는 문을 지어내지 않는다', () => {
    const view = renderCard({gates: new Map()});
    expect(within(view.getByTestId('agent-card')).getByText(DEAD_END)).toBeTruthy();
  });
});

// -----------------------------------------------------------------------------
describe('fail-closed — 컨트롤이 서지 않는 네 가지', () => {
  const gates = new Map([['ap-1', GATE]]);

  it('① 결정할 대상이 없다 — 재개 제안에는 approvalId 가 없다', () => {
    const gate = gateFor(
      {
        kind: 'approval',
        approvalId: null,
        title: '새 호스트에서 재개',
        status: 'pending',
        isResumeOffer: true,
        detail: {rows: []},
      } as never,
      gates,
    );
    expect(gate).toBeNull();
  });

  it('② 카드가 이미 끝났다고 말한다', () => {
    for (const status of ['approved', 'rejected', 'expired', 'cancelled']) {
      expect(
        gateFor(
          {
            kind: 'approval',
            approvalId: 'ap-1',
            title: 't',
            status,
            isResumeOffer: false,
            detail: {rows: []},
          } as never,
          gates,
        ),
      ).toBeNull();
    }
  });

  it('③ 원장이 더 이상 대기라고 말하지 않는다 — 이 문은 목록만 안다', () => {
    // 이것이 이 설계의 값이다. 다른 데서 이미 결정되면 그 승인은 대기 목록에서
    // 빠지는데, **카드의 `status` 는 그 메시지가 새 프레임으로 갱신될 때까지
    // 여전히 `pending`** 이다. 카드만 보면 이미 끝난 결정을 다시 누를 수 있다.
    const stillPendingCard = {
      kind: 'approval',
      approvalId: 'ap-1',
      title: 't',
      status: 'pending',
      isResumeOffer: false,
      detail: {rows: []},
    } as never;
    expect(gateFor(stillPendingCard, gates)).not.toBeNull();
    expect(gateFor(stillPendingCard, new Map())).toBeNull();
  });

  it('④ 서버가 승인 경로를 안 실었으면 목록이 비어 있다', () => {
    // 훅이 `isSurfaceProvided('approvals')` 로 쿼리를 끄므로 표가 빈 채로 온다.
    // 그 결과는 ③과 같다 — 컨트롤이 안 선다.
    expect(approvalGates(undefined, 'ch').size).toBe(0);
  });

  it('대기가 아닌 것이 목록에 섞여 와도 대기로 읽지 않는다', () => {
    expect(approvalGates([approval({status: 'approved'})], 'ch').size).toBe(0);
  });

  it('다른 채널의 승인은 이 대화의 카드를 열지 않는다', () => {
    expect(approvalGates([approval({channelId: 'other'})], 'ch').size).toBe(0);
  });
});

// -----------------------------------------------------------------------------
describe('모르는 것을 안다고 말하지 않는다', () => {
  it('기한을 모르면 만료를 주장하지 않는다', () => {
    // `deadlinePassed` 는 버튼을 막는 게이트가 아니라 **확정 문장**을 정한다:
    // 기한이 지난 뒤 보내면 서버는 승인/거부가 아니라 만료로 확정한다. 모르는
    // 것을 「지났다」로 넘기면 그 문장이 거짓말을 한다.
    expect(deadlinePassed({...GATE, expiresAtMs: null}, BASE_MS)).toBe(false);
    expect(deadlinePassed({...GATE, expiresAtMs: BASE_MS + 1}, BASE_MS)).toBe(false);
    expect(deadlinePassed({...GATE, expiresAtMs: BASE_MS}, BASE_MS)).toBe(true);
  });

  it('서버가 가역이라 말한 것만 가역이다 — 없으면 되돌릴 수 없는 것으로 본다', () => {
    expect(approvalGates([approval()], 'ch').get('ap-1')?.reversible).toBe(false);
    expect(
      approvalGates([approval({isReversible: true})], 'ch').get('ap-1')?.reversible,
    ).toBe(true);
  });

  it('게이트는 기한이 지났는지가 아니라 **기한 자체**를 든다', () => {
    // 시계가 움직일 때마다 새 값이 되면 이 행의 memo 가 영영 적중하지 못한다
    // (goal RN-P2a 가 산 것). 판단은 행이 자기 `nowMs` 로 그때 한다.
    const gate = approvalGates([approval({expiresAtMs: BASE_MS})], 'ch').get('ap-1');
    expect(gate).toMatchObject({expiresAtMs: BASE_MS});
    expect(gate).not.toHaveProperty('deadlinePassed');
  });
});

// -----------------------------------------------------------------------------
describe('영수증과 컨트롤은 같은 순간에 서로 반대로 움직인다', () => {
  it('영수증이 있으면 컨트롤 대신 영수증이다', () => {
    const view = renderCard({
      gates: new Map([['ap-1', GATE]]),
      receipts: new Map([['ap-1', '승인을 기록했습니다.']]),
    });
    const agentCard = view.getByTestId('agent-card');
    expect(
      within(agentCard).getByTestId('card-approval-receipt').props.children,
    ).toBe('승인을 기록했습니다.');
    expect(
      within(agentCard).queryByTestId('card-approval-ap-1-actions'),
    ).toBeNull();
  });

  it('결정 뒤 목록에서 빠져도 영수증은 남는다 — 컨트롤만 사라진다', () => {
    // 결정한 순간 그 승인은 대기 목록에서 빠진다. 영수증을 행의 상태로 뒀다면
    // 그때 함께 사라져, 방금 누른 사람은 자기가 무엇을 했는지 못 본 채 카드가
    // 조용히 바뀐 것만 본다.
    const view = renderCard({
      gates: new Map(),
      receipts: new Map([['ap-1', '거부를 기록했습니다.']]),
    });
    const agentCard = view.getByTestId('agent-card');
    expect(within(agentCard).getByTestId('card-approval-receipt')).toBeTruthy();
    expect(within(agentCard).queryByText(DEAD_END)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
describe('두 번째 구현이 아니라 세 번째 호출자다', () => {
  const SRC = (p: string) =>
    fs.readFileSync(path.resolve(__dirname, `../src/${p}`), 'utf8');
  const codeOnly = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('타임라인이 결정 함수를 직접 부르지 않는다', () => {
    // 부르는 순간 이 화면은 자기만의 멱등 정책과 자기만의 409 해석을 갖게 되고,
    // 갈라진 쪽은 아무도 보고 있지 않은 쪽이다.
    const row = codeOnly(SRC('features/conversation/MessageRow.tsx'));
    expect(row).toContain('ApprovalDecision');
    expect(row).not.toContain('decideApproval');
    expect(row).not.toContain('newDecisionId');
  });

  it('영수증 문구가 한 벌이다 — 화면마다 다시 적지 않는다', () => {
    const screenSrc = codeOnly(SRC('screens/ConversationScreen.tsx'));
    expect(screenSrc).toContain('decisionReceiptCopy');
    expect(screenSrc).not.toContain('승인을 기록했습니다');
    expect(codeOnly(SRC('screens/InboxScreen.tsx'))).not.toContain(
      '승인을 기록했습니다',
    );
  });

  it('인박스와 같은 캐시 항목을 본다 — 키가 갈라지면 두 화면이 다른 사실을 본다', () => {
    // 인박스에서 결정하고 대화로 돌아오면 그 카드의 컨트롤이 **이미** 사라져
    // 있어야 한다. 그건 같은 키를 쓸 때만 참이다.
    const inbox = codeOnly(SRC('features/inbox/useInbox.ts'));
    expect(inbox).toContain("['approvals', workspaceId, 'pending']");
    expect(pendingApprovalsKey(WS)).toEqual(['approvals', WS, 'pending']);
  });
});
