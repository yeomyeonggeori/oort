import type {Member, Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {cleanup, render, within} from '@testing-library/react-native';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import {StyleSheet} from 'react-native';

import {Composer} from '../src/features/conversation/Composer';

import {
  approvalGates,
  deadlinePassed,
  gateFor,
  type ApprovalGate,
  type ApprovalReceipt,
} from '../src/features/conversation/approvalGate';
import {pendingApprovalsKey} from '../src/features/conversation/usePendingApprovals';
import {APPROVAL_OFFLINE_COPY} from '../src/features/inbox/useOnline';
import {
  approvalNoteRank,
  APPROVAL_NOTE_TONE_ORDER,
} from '@momo/core/features/timeline/approvalNote';
import {color} from '../src/design/tokens';
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
  receipts?: ReadonlyMap<string, ApprovalReceipt>;
  offline?: boolean;
  approvalsProvided?: boolean;
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
          approvalOffline={props.offline}
          approvalsProvided={props.approvalsProvided}
          onApprovalSettled={() => {}}
        />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

const DEAD_END = '이 결정은 인박스나 데스크톱 앱에서 처리할 수 있습니다.';

/** 잉크의 밝기. 「격상이 실제로 격상인가」를 값으로 묻는 데만 쓴다. */
function brightness(hex: string): number {
  const h = hex.replace('#', '');
  return [0, 2, 4].reduce((sum, i) => sum + parseInt(h.slice(i, i + 2), 16), 0);
}

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
  it('영수증이 있으면 상태 칩도 원장이 답한 것을 말한다', () => {
    // 사진이 이 모순을 잡아냈다: 영수증은 「승인을 기록했습니다」인데 칩은
    // 여전히 「승인 대기」였다. 칩은 카드 **스냅샷**의 status 를 읽고, 그
    // 스냅샷은 서버가 새 프레임을 보낼 때까지 갱신되지 않는다.
    const view = renderCard({
      gates: new Map(),
      receipts: new Map([
        ['ap-1', {note: '승인을 기록했습니다.', status: 'approved'}],
      ]),
    });
    const agentCard = view.getByTestId('agent-card');
    expect(within(agentCard).queryByText('승인 대기')).toBeNull();
  });

  it('원장이 상태를 모르면 칩은 스냅샷을 그대로 둔다 — 지어내지 않는다', () => {
    const view = renderCard({
      gates: new Map(),
      receipts: new Map([
        ['ap-1', {note: '결정을 보냈습니다. 기록된 상태는 목록에서 확인하세요.'}],
      ]),
    });
    expect(
      within(view.getByTestId('agent-card')).getByText('승인 대기'),
    ).toBeTruthy();
  });

  it('영수증이 있으면 컨트롤 대신 영수증이다', () => {
    const view = renderCard({
      gates: new Map([['ap-1', GATE]]),
      receipts: new Map([
        ['ap-1', {note: '승인을 기록했습니다.', status: 'approved'}],
      ]),
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
      receipts: new Map([
        ['ap-1', {note: '거부를 기록했습니다.', status: 'rejected'}],
      ]),
    });
    const agentCard = view.getByTestId('agent-card');
    expect(within(agentCard).getByTestId('card-approval-receipt')).toBeTruthy();
    expect(within(agentCard).queryByText(DEAD_END)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
describe('게이트를 건네면 세션이 필요하다 — 안 건네면 아니다', () => {
  // 이 계약은 **하네스가 처음 어겼고 사진이 그것을 잡아냈다**: `approval-card`
  // 표면이 빨간 `useSession() was called outside SessionProvider` 로 찍혔다.
  // `ApprovalDecision` 은 결정을 어느 워크스페이스로 보낼지 세션에서 읽는다.
  it('읽기 전용 표면은 세션 없이도 그대로 선다 — 게이트를 안 건네므로', () => {
    const view = render(
      <MessageRow
        message={card()}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
      />,
    );
    expect(view.getByTestId('agent-card')).toBeTruthy();
    expect(within(view.getByTestId('agent-card')).getByText(DEAD_END)).toBeTruthy();
  });

  it('측정 하네스가 그 계약을 지킨다 — 세션을 세운다', () => {
    const harness = fs.readFileSync(
      path.resolve(__dirname, '../measure/surfaces.tsx'),
      'utf8',
    );
    expect(harness).toContain('SessionProvider');
    expect(harness).toContain("case 'approval-card'");
  });
});

// -----------------------------------------------------------------------------
describe('오프라인 — 같은 컨트롤은 화면마다 같은 결을 갖는다', () => {
  it('연결이 끊기면 컨트롤 대신 인박스와 **같은 문장**이 선다', () => {
    const view = renderCard({gates: new Map([['ap-1', GATE]]), offline: true});
    const agentCard = view.getByTestId('agent-card');
    expect(
      within(agentCard).getByTestId('card-approval-offline').props.children,
    ).toBe(APPROVAL_OFFLINE_COPY);
    expect(
      within(agentCard).queryByTestId('card-approval-ap-1-actions'),
    ).toBeNull();
    // 「다른 데서 하세요」와 다른 문장이어야 한다 — 이건 자리의 문제가 아니라
    // **때**의 문제다.
    expect(within(agentCard).queryByText(DEAD_END)).toBeNull();
  });

  it('영수증은 오프라인보다 세다 — 이미 끝난 결정은 연결과 무관하다', () => {
    const view = renderCard({
      gates: new Map([['ap-1', GATE]]),
      offline: true,
      receipts: new Map([
        ['ap-1', {note: '승인을 기록했습니다.', status: 'approved'}],
      ]),
    });
    expect(
      within(view.getByTestId('agent-card')).getByTestId(
        'card-approval-receipt',
      ),
    ).toBeTruthy();
  });

  it('결정할 수 없는 카드는 오프라인이어도 예전 문장이다', () => {
    // 오프라인은 「지금은 못 보낸다」이고 게이트 없음은 「여기서 할 일이
    // 아니다」다. 둘을 섞으면 다시 연결됐을 때 사람이 여기서 기다린다.
    const view = renderCard({gates: new Map(), offline: true});
    expect(within(view.getByTestId('agent-card')).getByText(DEAD_END)).toBeTruthy();
  });

  it('문장이 한 벌이다 — 이제 두 화면이 아니라 **두 클라**가 (U4-6)', () => {
    const SRC2 = (p: string) =>
      fs.readFileSync(path.resolve(__dirname, `../src/${p}`), 'utf8');
    const codeOnly2 = (t: string) =>
      t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // 문장을 손으로 적은 자리가 **하나도** 없다. 값이 사는 자리는 코어 하나다.
    for (const file of [
      'screens/InboxScreen.tsx',
      'features/conversation/MessageRow.tsx',
      'features/inbox/useOnline.ts',
    ]) {
      expect(codeOnly2(SRC2(file))).not.toContain(
        '연결이 끊겨 지금은 결정할 수 없습니다',
      );
    }
    // 인박스는 이름으로 부르고(그 화면의 진입점이 `useOnline.ts` 다), 그 이름은
    // 코어에서 다시 내보내는 것이다.
    expect(codeOnly2(SRC2('screens/InboxScreen.tsx'))).toContain(
      'APPROVAL_OFFLINE_COPY',
    );
    expect(codeOnly2(SRC2('features/inbox/useOnline.ts'))).toContain(
      "from '@momo/core/features/timeline/approvalNote'",
    );
    // 카드는 상수조차 안 든다 — **어떤 문장이 서는가**를 코어가 판정한다.
    expect(codeOnly2(SRC2('features/conversation/MessageRow.tsx'))).toContain(
      'approvalCardNote',
    );
  });

  it('레일 상태가 아니라 네트워크를 본다 — 결정도 전송도 REST 로 나간다', () => {
    // 레일은 웹소켓이다. 재연결 중이어도 그 POST 는 멀쩡히 성공하고, 승인에는
    // 기한이 있으므로 할 수 있는 결정을 막는 쪽이 더 비싸다.
    //
    // **이 단정은 goal U4-6M 에서 넓어졌지, 좁아지지 않았다.** 원래는 승인
    // 컨트롤 하나에 대한 것이었는데, 컴포저가 같은 범주 오류를 그대로 갖고
    // 있었다 — 전송도 REST POST 인데 `disabled={railStatus === 'disconnected'}`
    // 를 읽었다. 두 소비자가 같은 신호를 들게 됐으므로 이름도 소비자 하나를
    // 가리키지 않는다(`approvalOnline` → `networkOnline`). 바뀐 것은 이름과
    // 소비자 수뿐이고, 지키는 결정은 같다: **레일은 「보낼 수 있는가」에
    // 답하지 않는다.**
    const screenSrc = fs.readFileSync(
      path.resolve(__dirname, '../src/screens/ConversationScreen.tsx'),
      'utf8',
    );
    expect(screenSrc).toMatch(/const networkOnline = useOnline\(\)/);
    expect(screenSrc).not.toMatch(/approvalOffline=\{railStatus/);
    // 컴포저 몫 (U4-6M). 레일을 다시 들면 여기서 빨강이 된다.
    expect(screenSrc).toMatch(/offline=\{!networkOnline\}/);
    expect(screenSrc).not.toMatch(/disabled=\{railStatus/);
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

// -----------------------------------------------------------------------------
// U4-4 M-3 — 세 문장이 같은 옷을 입지 않는다 (코어 승격분 소비)
//
// 리뷰가 실측한 것: 영수증(`승인을 기록했습니다.`)·안내(`이 결정은 인박스나…`)·
// 오프라인 문장이 전부 `styles.cardNote` 한 벌이었다. *"카드에서 가장 값어치
// 있는 문장인 영수증이 가장 조용한 차림으로 나온다."*
//
// 격의 **순서**는 코어가 정하고(`APPROVAL_NOTE_TONE_ORDER`), 그 순서를 이
// 팔레트가 실제로 지키는지는 **그려진 트리에서** 잰다. 소스 매칭이 아니라 실표를
// 보는 이유는 U4-4R W-2 그대로다.
// -----------------------------------------------------------------------------

describe('M-3 — 승인 카드 세 문장의 격', () => {
  const flatten = (style: unknown): Record<string, unknown> =>
    Array.isArray(style)
      ? Object.assign({}, ...style.filter(Boolean).map(flatten))
      : ((style ?? {}) as Record<string, unknown>);

  /** 카드가 실제로 그린 줄의 잉크와 무게. */
  function noteFace(props: Parameters<typeof renderCard>[0], kind: string) {
    const view = renderCard(props);
    const node = within(view.getByTestId('agent-card')).getByTestId(
      `card-approval-${kind}`,
    );
    const style = flatten(node.props.style) as {
      color?: string;
      fontWeight?: string;
    };
    const face = {color: style.color, weight: style.fontWeight ?? '400'};
    view.unmount();
    return face;
  }

  const RECEIPT = new Map([
    ['ap-1', {note: '승인을 기록했습니다.', status: 'approved' as const}],
  ]);

  it('세 갈래가 코어가 말한 kind 로 선다', () => {
    // 종류(왜 이 줄이 섰는가)와 톤(얼마나 앞으로 나오는가)이 나뉘어 있으므로,
    // 테스트도 종류로 지목한다.
    for (const [props, kind] of [
      [{gates: new Map([['ap-1', GATE]]), receipts: RECEIPT}, 'receipt'],
      [{gates: new Map([['ap-1', GATE]]), offline: true}, 'offline'],
      [{gates: new Map()}, 'elsewhere'],
    ] as const) {
      const view = renderCard(props);
      expect(view.queryByTestId(`card-approval-${kind}`)).toBeTruthy();
      view.unmount();
    }
  });

  it('영수증 > 차단 > 안내 — 격이 실제로 갈린다', () => {
    const receipt = noteFace(
      {gates: new Map([['ap-1', GATE]]), receipts: RECEIPT},
      'receipt',
    );
    const blocked = noteFace(
      {gates: new Map([['ap-1', GATE]]), offline: true},
      'offline',
    );
    const guidance = noteFace({gates: new Map()}, 'elsewhere');

    // 세 벌이 서로 다르다 — 옛 판은 셋이 같은 `cardNote` 하나였다.
    const faces = [receipt, blocked, guidance].map(f => `${f.color}/${f.weight}`);
    expect(new Set(faces).size).toBe(3);

    // 그리고 방향이 옳다: 영수증만 굵고, 안내만 흐리다.
    expect(receipt.weight).toBe('600');
    expect(blocked.weight).toBe('400');
    expect(guidance.weight).toBe('400');
    expect(receipt.color).toBe(color.text);
    expect(blocked.color).toBe(color.text);
    expect(guidance.color).toBe(color.textMuted);
    // 격상이 실제로 격상이다 — 영수증의 잉크가 안내의 잉크보다 **밝다**.
    // (`text` #ececf1 ↔ `textMuted` #9b98a3 — 값은 `tokens.ts` 에서 읽는다.)
    expect(brightness(color.text)).toBeGreaterThan(brightness(color.textMuted));
  });

  it('색상은 새로 들이지 않았다 — 앰버는 이미 경계의 뜻이다 (D-2)', () => {
    // 「일시적 차단」에 `warn` 을 주면 같은 배치가 앰버에 세 번째 뜻을 준다.
    for (const kind of ['receipt', 'offline', 'elsewhere'] as const) {
      const props =
        kind === 'receipt'
          ? {gates: new Map([['ap-1', GATE]]), receipts: RECEIPT}
          : kind === 'offline'
            ? {gates: new Map([['ap-1', GATE]]), offline: true}
            : {gates: new Map()};
      expect(noteFace(props, kind).color).not.toBe(color.warn);
    }
  });

  it('컴포저의 「지금은 못 보낸다」도 같은 잉크다 (U4-6 리뷰 M-2)', () => {
    // 두 줄은 같은 종류의 말이다 — 코어가 이름까지 붙였다(`blocked`: 자리의
    // 문제가 아니라 **때**의 문제). 그런데 같은 배치에서 승인 줄은 `text`/400
    // 으로 서고 컴포저 줄만 `warn` 이었다. 한 화면 안에서 같은 말이 두 옷을
    // 입으면, 사람은 그 차이를 뜻으로 읽는다.
    const blocked = noteFace(
      {gates: new Map([['ap-1', GATE]]), offline: true},
      'offline',
    );
    const view = render(
      <Composer recipient="place"
        channelLabel="배포"
        directory={DIRECTORY}
        offline
        onSend={() => {}}
      />,
    );
    const composerLine = StyleSheet.flatten(
      view.getByTestId('composer-offline').props.style,
    ) as {color?: string};
    view.unmount();

    expect(composerLine.color).toBe(blocked.color);
    // 그리고 그 잉크가 앰버가 아니다 — D-2 의 기각을 컴포저에서 되살리지 않는다.
    expect(composerLine.color).not.toBe(color.warn);
  });

  it('격의 순서가 코어의 순서다', () => {
    expect(APPROVAL_NOTE_TONE_ORDER).toEqual(['receipt', 'blocked', 'guidance']);
    expect(approvalNoteRank('receipt')).toBeLessThan(approvalNoteRank('blocked'));
    expect(approvalNoteRank('blocked')).toBeLessThan(
      approvalNoteRank('guidance'),
    );
  });

  it('재개 제안은 승인 문장을 입지 않는다 — 승인이 아니다', () => {
    // 옛 판은 `approval === null` 이라는 이유로 「이 결정은 인박스나 데스크톱
    // 앱에서」를 붙였다. 재개 제안에는 결정할 대상이 아예 없다.
    const view = renderCard({
      message: card({approval_id: null, kind: 'resume_offer'}),
      gates: new Map(),
    });
    const agentCard = view.getByTestId('agent-card');
    expect(within(agentCard).queryByText(DEAD_END)).toBeNull();
    expect(within(agentCard).queryByTestId('card-approval-elsewhere')).toBeNull();
  });

  it('원장 없는 서버는 오프라인 문장을 말하지 않는다 — 「다시 연결되면」이 거짓말이다', () => {
    const view = renderCard({
      gates: new Map([['ap-1', GATE]]),
      offline: true,
      approvalsProvided: false,
    });
    const agentCard = view.getByTestId('agent-card');
    expect(within(agentCard).queryByTestId('card-approval-offline')).toBeNull();
    expect(within(agentCard).getByTestId('card-approval-unsupported')).toBeTruthy();
  });
});

// -----------------------------------------------------------------------------
// B-1 (U4-6 병합 리뷰) — 코어가 `decidable` 하나를 셋으로 가른 뒤, **이 클라의
// 호출부만 옛 이름으로 남아 있었다**.
//
// 병합 트리에서 실제로 일어난 일: 넘기지 않은 `settled`·`hasTarget` 이
// `undefined` 라 `settled || !hasTarget` 이 참이 되고, 영수증 말고는 전부 `null`
// 이 됐다. 그리고 이 화면에서 `null` 은 「할 말이 없다」가 아니라 **「컨트롤이
// 선다」**이므로 — 연결이 끊긴 채로 승인·거부 버튼이 되살아났다. tsc 는 그것을
// 한 줄로 말했지만(TS2353) 스위트는 8건이 붉었을 뿐 화면이 왜 그렇게 되는지는
// 아래 두 단정이 말한다.
// -----------------------------------------------------------------------------
describe('B-1 — 판정 입력 셋이 각자 다른 사실을 나른다', () => {
  it('끝난 결정에는 아무 줄도 세우지 않는다 — 컨트롤도, 「다른 데서 하세요」도', () => {
    // `settled` 가 접혀 있던 동안 이 카드는 **거짓 안내**를 입었다: 처리할 것이
    // 없는데 인박스로 가라고 한다. 끝난 카드가 할 말은 원장 줄이 이미 한다.
    for (const status of ['approved', 'rejected', 'expired', 'cancelled']) {
      const view = renderCard({
        message: card({approval_status: status}),
        gates: new Map(),
      });
      const agentCard = view.getByTestId('agent-card');
      expect(within(agentCard).queryByText(DEAD_END)).toBeNull();
      expect(
        within(agentCard).queryByTestId('card-approval-elsewhere'),
      ).toBeNull();
      expect(
        within(agentCard).queryByTestId('card-approval-ap-1-actions'),
      ).toBeNull();
      view.unmount();
    }
  });

  it('원장이 방금 답한 것도 「끝났다」로 읽는다 — 칩과 같은 값을 본다', () => {
    // 영수증 갈래가 먼저 서므로 화면은 영수증이지만, 그 아래 판정에 들어가는
    // `settled` 는 칩이 읽는 값(`receipt.status ?? card.status`)과 같아야 한다.
    // 다르면 한 카드가 한 줄에서 두 가지를 말한다.
    const view = renderCard({
      gates: new Map([['ap-1', GATE]]),
      receipts: new Map([
        ['ap-1', {note: '승인을 기록했습니다.', status: 'approved'}],
      ]),
    });
    const agentCard = view.getByTestId('agent-card');
    expect(within(agentCard).getByTestId('card-approval-receipt')).toBeTruthy();
    expect(
      within(agentCard).queryByTestId('card-approval-ap-1-actions'),
    ).toBeNull();
    expect(within(agentCard).getByText('승인됨')).toBeTruthy();
  });

  it('옛 이름을 다시 넣으면 여기서 빨강이다 — tsc 한 줄이 화면 전체였다', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/features/conversation/MessageRow.tsx'),
      'utf8',
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bdecidable\s*:/);
    for (const key of ['settled:', 'hasTarget:', 'pendingHere:']) {
      expect(code).toContain(key);
    }
  });
});
