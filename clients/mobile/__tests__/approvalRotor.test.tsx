import type {Member, Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo} from 'react-native';

import '../src/boot/polyfills';

import type {
  ApprovalGate,
  ApprovalReceipt,
} from '../src/features/conversation/approvalGate';
import {MessageRow} from '../src/features/conversation/MessageRow';
import {SessionProvider} from '../src/session/useSession';

// =============================================================================
// VoiceOver 가 타임라인 승인 카드의 결정에 닿는다 (#2595, #3852).
//
// 타임라인 행은 접근성 요소 **하나**다(`accessible`). iOS 에서 그 안의 버튼은 따로
// 초점을 받지 못하므로, 카드 안 「승인」·「거부」는 화면을 보지 않는 사람에게 없는
// 것과 같았다(#1087 부터). 고친 방법은 로터 사용자 지정 동작이다 — 행이
// `momoApprove`·`momoReject` 를 내고, 그 동작이 버튼과 **같은 결정 함수**를 부른다.
//
// 그래서 이 파일은 둘을 잰다.
//   ① 행의 `accessibilityActions` 에 두 동작이 실제로 있다(도달).
//   ② 그 동작을 부르면 결정이 정확히 한 번, 버튼과 같은 모양으로 나간다(동작).
// 그리고 버튼이 서지 않는 자리(결정됨·끊김·대상 없음)에서는 로터에도 없다.
// =============================================================================

const mockDecide = jest.fn();
jest.mock('@momo/core/features/timeline/approvalDecision', () => {
  const actual = jest.requireActual('@momo/core/features/timeline/approvalDecision');
  return {...actual, decideApproval: (...args: unknown[]) => mockDecide(...args)};
});

const WS = 'ws-1';
const SELF = '11111111-1111-4111-8111-111111111111';
const AGENT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BASE_MS = 1_700_000_000_000;

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

function member(id: string): RosterMember {
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
  } as RosterMember;
}

const DIRECTORY = makeDirectory([member(SELF), member(AGENT)]);
const ME = {id: SELF, workspaceId: WS, displayName: '곽성재'} as Member;
const GATE: ApprovalGate = {approvalId: 'ap-1', reversible: false, expiresAtMs: null};
const GATES = new Map([['ap-1', GATE]]);

function renderRow(props: {
  message?: Message;
  gates?: ReadonlyMap<string, ApprovalGate>;
  receipts?: ReadonlyMap<string, ApprovalReceipt>;
  offline?: boolean;
  onSettled?: jest.Mock;
  viewer?: boolean;
  onOpenDecision?: (approvalId: string) => void;
}) {
  const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}});
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
          onApprovalSettled={props.onSettled ?? (() => {})}
          actions={props.viewer ? {myMemberId: SELF, onOpenDecision: props.onOpenDecision,
            onToggleReaction: async () => {}, onEdit: async () => {}, onDelete: async () => {}} : undefined}
        />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

function rotor(): {name: string; label: string}[] {
  return (screen.getByTestId('message-row').props.accessibilityActions ?? []) as {
    name: string;
    label: string;
  }[];
}

/** VoiceOver 는 행이 **내놓은** 동작만 부를 수 있다. 내놓지 않은 이름은 부르지 못한다. */
async function invoke(actionName: string) {
  expect(rotor().map(action => action.name)).toContain(actionName);
  await act(async () => {
    fireEvent(screen.getByTestId('message-row'), 'accessibilityAction', {
      nativeEvent: {actionName},
    });
  });
}

beforeEach(() => {
  mockDecide.mockReset();
  mockDecide.mockResolvedValue({kind: 'committed', status: 'approved'});
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

describe('#2595 — 로터에서 승인·거부에 닿는다', () => {
  it('묶음 카드는 자신의 접근성 그룹에서 같은 승인 함수를 한 번 호출해요', async () => {
    renderRow({viewer: true, gates: GATES, message: card({intent: '소개를 바꾸려고 해요', can_decide: true, decision_mode: 'inline'})});
    const bundle = screen.getByTestId('request-bundle-card');
    expect(bundle.props.accessible).toBe(true);
    expect(screen.getByTestId('message-row').props.accessible).toBe(false);
    expect(bundle.props.accessibilityActions).toEqual(expect.arrayContaining([
      {name: 'approve', label: '승인'}, {name: 'reject', label: '거부'}, {name: 'details', label: '자세히'},
    ]));
    await act(async () => fireEvent(bundle, 'accessibilityAction', {nativeEvent: {actionName: 'approve'}}));
    expect(mockDecide).toHaveBeenCalledTimes(1);
    expect(mockDecide.mock.calls[0].slice(0, 3)).toEqual([WS, 'ap-1', true]);
  });
  it('결정 무대 prop이 있으면 그 자리만 열고 카드에서 결정하지 않아요', async () => {
    const open = jest.fn();
    renderRow({viewer: true, onOpenDecision: open, gates: GATES, message: card({intent: '비공개 채널을 만들려고 해요', can_decide: true, decision_mode: 'open'})});
    const bundle = screen.getByTestId('request-bundle-card');
    expect(bundle.props.accessibilityActions).toEqual(expect.arrayContaining([{name: 'openDecision', label: '열어서 결정'}]));
    expect(screen.queryByTestId('card-approval-ap-1-approve')).toBeNull();
    await act(async () => fireEvent(bundle, 'accessibilityAction', {nativeEvent: {actionName: 'openDecision'}}));
    expect(open).toHaveBeenCalledWith('ap-1');
    expect(mockDecide).not.toHaveBeenCalled();
  });
  it('행은 여전히 요소 하나이고, 그 요소가 「승인」·「거부」 동작을 낸다', () => {
    renderRow({gates: GATES});
    const row = screen.getByTestId('message-row');
    expect(row.props.accessible).toBe(true);
    const labels = rotor().map(action => action.label);
    expect(labels).toEqual(expect.arrayContaining(['승인', '거부']));
    // 버튼과 같은 낱말이다 — 눈과 귀가 같은 것을 같은 이름으로 부른다.
    expect(screen.getByTestId('card-approval-ap-1-approve').props.accessibilityLabel).toBe('승인');
    expect(screen.getByTestId('card-approval-ap-1-reject').props.accessibilityLabel).toBe('거부');
  });

  it('「승인」 동작은 버튼과 같은 결정을 한 번 보낸다', async () => {
    const onSettled = jest.fn();
    renderRow({gates: GATES, onSettled});
    await invoke('momoApprove');
    expect(mockDecide).toHaveBeenCalledTimes(1);
    const [ws, approvalId, approve, key] = mockDecide.mock.calls[0];
    expect([ws, approvalId, approve]).toEqual([WS, 'ap-1', true]);
    expect(typeof key).toBe('string');
    expect(onSettled).toHaveBeenCalledWith('ap-1', {kind: 'committed', status: 'approved'});
  });

  it('「거부」 동작은 거부를 보낸다', async () => {
    mockDecide.mockResolvedValue({kind: 'committed', status: 'rejected'});
    renderRow({gates: GATES});
    await invoke('momoReject');
    expect(mockDecide).toHaveBeenCalledTimes(1);
    expect(mockDecide.mock.calls[0][2]).toBe(false);
  });

  it('보내는 중에 다시 불러도 두 번째 결정은 나가지 않는다 — 버튼과 같은 잠금', async () => {
    mockDecide.mockImplementation(() => new Promise(() => {}));
    renderRow({gates: GATES});
    await invoke('momoApprove');
    await invoke('momoApprove');
    await invoke('momoReject');
    expect(mockDecide).toHaveBeenCalledTimes(1);
  });

  it('실패는 소리로 한 번 말한다 — 초점이 행 위에 있어 그 줄을 읽지 못한다', async () => {
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => {});
    mockDecide.mockResolvedValue({
      kind: 'error',
      errorCopy: '결정이 서버에 닿지 못했어요. 연결을 확인하고 다시 눌러 주세요.',
    });
    renderRow({gates: GATES});
    await invoke('momoApprove');
    expect(announce).toHaveBeenCalledWith(
      '결정이 서버에 닿지 못했어요. 연결을 확인하고 다시 눌러 주세요.',
    );
  });
});

describe('#3854 H-2 — 로터로 보낸 결정은 성공도 소리로 말한다', () => {
  // 행은 요소 하나라 카드의 영수증 줄이 낭독 라벨에 들어가지 않는다. 로터의 동작은
  // 결정 뒤 말없이 사라진다. 소리가 없으면 결정이 나갔는지 알 길이 없다.
  it.each([
    [{kind: 'committed', status: 'approved'}, 'momoApprove', '승인을 기록했어요.'],
    [{kind: 'committed', status: 'rejected'}, 'momoReject', '거부를 기록했어요.'],
    [
      {kind: 'superseded', status: 'approved', note: '다른 곳에서 이미 결정됐어요.'},
      'momoApprove',
      '이미 승인으로 기록되어 있었어요.',
    ],
  ])('%j → 「%s」 뒤 영수증을 말한다', async (outcome, action, spoken) => {
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => {});
    // RN 의 jest 준비가 이 함수를 이미 mock 으로 두어 앞 시험의 호출이 남는다.
    announce.mockClear();
    mockDecide.mockResolvedValue(outcome);
    renderRow({gates: GATES});
    await invoke(action);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(spoken);
  });

  it('버튼을 눌러 결정한 사람에게는 말하지 않는다 — 눈이 영수증을 읽는다', async () => {
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => {});
    // RN 의 jest 준비가 이 함수를 이미 mock 으로 두어 앞 시험의 호출이 남는다.
    announce.mockClear();
    renderRow({gates: GATES});
    await act(async () => {
      fireEvent.press(screen.getByTestId('card-approval-ap-1-approve'));
    });
    expect(mockDecide).toHaveBeenCalledTimes(1);
    expect(announce).not.toHaveBeenCalled();
  });
});

describe('버튼이 서지 않는 자리에서는 로터에도 없다', () => {
  const names = () => rotor().map(action => action.name);

  it('결정할 수 없는 카드(대기 목록에 없음)', () => {
    renderRow({gates: new Map()});
    expect(names()).not.toContain('momoApprove');
    expect(names()).not.toContain('momoReject');
  });

  it('이미 결정된 카드(영수증)', () => {
    renderRow({
      gates: GATES,
      receipts: new Map([['ap-1', {note: '승인을 기록했어요.', status: 'approved'}]]),
    });
    expect(screen.queryByTestId('card-approval-ap-1-approve')).toBeNull();
    expect(names()).not.toContain('momoApprove');
    expect(names()).not.toContain('momoReject');
  });

  it('연결이 끊긴 동안', () => {
    renderRow({gates: GATES, offline: true});
    expect(screen.queryByTestId('card-approval-ap-1-approve')).toBeNull();
    expect(names()).not.toContain('momoApprove');
  });
});
