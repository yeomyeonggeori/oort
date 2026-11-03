import {reproposeDraft} from '@momo/core/features/approvals/expiry';
import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo} from 'react-native';

import type {ApprovalReceipt} from '../src/features/conversation/approvalGate';
import {Timeline} from '../src/features/conversation/Timeline';

// =============================================================================
// #5171 (화면 검수 3회차 M2). 웹 승인 카드는 만료·거부·실패로 닫힌 뒤 다음 행동 「다시 요청」을 건네는데(`AgentCard`,
// `AgentCard.nextAction.test.tsx`) 폰 묶음 카드는 「자세히」만 둬서 두 클라이언트가 달랐다. 서는 조건은 코어 함수 둘이 정한다
// (`cardReproposeReason` = 상태 + 거부한 사람, `reproposeTarget` = 올린 이가 에이전트인가). 폰은 그 둘을 그대로 읽고, 이 시험은
// 진짜 `Timeline` → `MessageRow` → `RequestBundleCard` 에서 웹과 같은 상태 표가 그대로 서는지를 잰다. 누르면 입력창에 같은
// 초안이 들어가는 길(`MessageRowActions.onRepropose` → `seedDraft`)은 `composerDraftSeed.test.tsx` 가 잰다.
//
// 픽스처는 서버가 쓰는 모양이다: 승인 카드는 `call_id` · `tool_name` · `action_type` 을 싣고 결정하면 `status` ·
// `approval_status` · `decided_by` 를 한 패치로 함께 고친다. 실패는 서버가 쓴 `result.status`(`failed`)로 온다.
// =============================================================================

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

const SELF_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const AGENT_ID = 'cccccccc-1111-4111-8111-cccccccccccc';
const BASE_MS = 1_700_000_000_000;
const NOW_MS = BASE_MS + 60_000;

function member(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: 'ws',
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
  } as RosterMember;
}

const DIRECTORY = makeDirectory([
  member({id: SELF_ID, displayName: '이도현', handle: 'dohyun'}),
  member({id: OTHER_ID, displayName: '박서연', handle: 'seoyeon'}),
  member({id: AGENT_ID, displayName: '김인턴', handle: 'kim-intern', kind: 'agent', ownerHumanId: SELF_ID}),
]);

function closedCard(
  status: string,
  extra: Record<string, unknown> = {},
  over: Partial<Message> = {},
): Message {
  return {
    id: 'approval_request-3',
    channelId: 'ch',
    seq: 3,
    hlcTs: 3,
    hlcCount: 0,
    authorMemberId: AGENT_ID,
    type: 'approval_request',
    body: '승인 요청',
    state: 'sent',
    createdAtMs: BASE_MS,
    props: {
      approval_id: 'ap-1',
      run_id: 'run-1',
      channel_id: 'ch',
      call_id: 'c1',
      tool_name: 'work.session.end',
      action_type: 'tool_call',
      title: '도구 「work.session.end」 실행',
      decision_mode: 'inline',
      approval_status: status,
      status,
      expires_at_ms: BASE_MS + 600_000,
      ...extra,
    },
    ...over,
  } as Message;
}

function renderCard(
  message: Message,
  options: {
    onRepropose?: ((draft: string) => boolean) | null;
    receipts?: ReadonlyMap<string, ApprovalReceipt>;
  } = {},
) {
  const onRepropose =
    options.onRepropose === null ? undefined : (options.onRepropose ?? jest.fn(() => true));
  render(
    <Timeline
      messages={[message]}
      directory={DIRECTORY}
      status="ready"
      myMemberId={SELF_ID}
      nowMs={NOW_MS}
      showRollup={false}
      approvalReceipts={options.receipts}
      actions={{
        myMemberId: SELF_ID,
        onToggleReaction: async () => {},
        onEdit: async () => {},
        onDelete: async () => {},
        ...(onRepropose === undefined ? {} : {onRepropose}),
      }}
    />,
  );
  return onRepropose;
}

const button = () => screen.queryByTestId('request-bundle-repropose');

describe('폰 묶음 카드의 「다시 요청」 — 웹 `AgentCard` 와 같은 상태 표 (#5171)', () => {
  it.each<[string, string, Record<string, unknown>, string | null]>([
    // [이름, 승인 상태, 덧붙일 props, 건네는 이유(없으면 null)]
    ['대기', 'pending', {}, null],
    ['승인됨(실행 중)', 'approved', {decided_by: OTHER_ID}, null],
    ['승인됨 + 서버가 쓴 결과(끝)', 'approved', {decided_by: OTHER_ID, result: {status: 'executed'}}, null],
    ['만료', 'expired', {}, 'expired'],
    ['거부(남이 한)', 'rejected', {decided_by: OTHER_ID}, 'declined'],
    ['거부(내가 한)', 'rejected', {decided_by: SELF_ID}, null],
    ['승인했다가 실패', 'approved', {decided_by: SELF_ID, result: {status: 'failed'}}, 'failed'],
    ['취소', 'cancelled', {}, null],
  ])('%s: 상태 표와 같게 서거나 서지 않는다', (_name, status, extra, reason) => {
    const onRepropose = renderCard(closedCard(status, extra));
    if (reason === null) {
      expect(button()).toBeNull();
      expect(screen.queryByTestId('request-bundle-closed-next')).toBeNull();
      return;
    }
    // 단추의 이름은 코어 상수 그대로이고, 누르면 이유에 맞는 초안이 이 화면의 입력창으로 간다.
    expect(button()).toHaveTextContent('다시 요청');
    fireEvent.press(button()!);
    expect(onRepropose).toHaveBeenCalledWith(reproposeDraft('kim-intern', reason as 'expired' | 'declined' | 'failed'));
  });

  it('기한이 시계로 지난 대기 카드도 만료로 읽어 「다시 요청」을 건넨다 — 서버가 정리하기 전에도', () => {
    const onRepropose = renderCard(closedCard('pending', {expires_at_ms: BASE_MS + 30_000}));
    expect(screen.getByTestId('request-state-expired')).toHaveTextContent('만료');
    fireEvent.press(button()!);
    expect(onRepropose).toHaveBeenCalledWith(reproposeDraft('kim-intern', 'expired'));
  });

  it('방금 내가 거부한 카드에는 카드가 `decided_by` 를 받기 전에도 서지 않는다: 영수증이 결정한 사람을 안다', () => {
    // 카드 스냅샷은 서버 프레임이 올 때까지 `pending` 이고 `decided_by` 가 없다 — 영수증(상태 + 결정한 사람)이 카드를 덮는다.
    renderCard(closedCard('pending'), {
      receipts: new Map([['ap-1', {status: 'rejected', note: '거부를 기록했어요.', decidedByMemberId: SELF_ID}]]),
    });
    expect(screen.getByTestId('request-state-declined')).toHaveTextContent('거부');
    expect(button()).toBeNull();
  });

  it('다른 곳에서 남이 먼저 거부한 것을 영수증으로 따라잡았으면 서고, 영수증의 결정자를 읽는다', () => {
    renderCard(closedCard('pending'), {
      receipts: new Map([['ap-1', {status: 'rejected', note: '다른 곳에서 먼저 결정됐어요.', decidedByMemberId: OTHER_ID}]]),
    });
    expect(button()).toHaveTextContent('다시 요청');
  });

  it('올린 이가 에이전트로 풀리지 않으면 단추도 빈 띠도 세우지 않는다', () => {
    renderCard(closedCard('expired', {}, {authorMemberId: OTHER_ID}));
    expect(screen.getByTestId('request-state-expired')).toBeTruthy();
    expect(button()).toBeNull();
    expect(screen.queryByTestId('request-bundle-closed-next')).toBeNull();
  });

  it('입력창이 없는 표면(`onRepropose` 없음)에는 눌러도 아무 일 없는 버튼을 세우지 않는다', () => {
    renderCard(closedCard('expired'), {onRepropose: null});
    expect(screen.getByTestId('request-state-expired')).toBeTruthy();
    expect(button()).toBeNull();
    expect(screen.getByTestId('request-bundle-card').props.accessibilityActions.map((a: {name: string}) => a.name)).not.toContain('다시 요청');
  });

  it('누르면 입력창에 넣었다는 한 줄이, 쓰던 글이 있어 거절당하면 못 넣었다는 한 줄이 서고 소리로도 알린다', () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    const onRepropose = jest.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderCard(closedCard('expired'), {onRepropose});
    expect(screen.queryByTestId('request-bundle-repropose-note')).toBeNull();

    fireEvent.press(button()!);
    expect(screen.getByTestId('request-bundle-repropose-note')).toHaveTextContent(/쓰던 글이 있어서 넣지 못했어요/);
    expect(announce).toHaveBeenLastCalledWith(expect.stringMatching(/넣지 못했어요/));

    fireEvent.press(button()!);
    expect(screen.getByTestId('request-bundle-repropose-note')).toHaveTextContent(/입력창에 넣어 뒀어요/);
    expect(announce).toHaveBeenLastCalledWith(expect.stringMatching(/넣어 뒀어요/));
    expect(onRepropose).toHaveBeenCalledTimes(2);
  });

  it('카드가 하나의 접근성 요소라서 로터 행동으로도 같은 일을 한다', () => {
    const onRepropose = renderCard(closedCard('failed', {result: {status: 'failed'}}));
    const cardNode = screen.getByTestId('request-bundle-card');
    expect(cardNode.props.accessibilityActions).toEqual(
      expect.arrayContaining([{name: '다시 요청', label: '다시 요청'}]),
    );
    fireEvent(cardNode, 'accessibilityAction', {nativeEvent: {actionName: '다시 요청'}});
    expect(onRepropose).toHaveBeenCalledWith(reproposeDraft('kim-intern', 'failed'));
  });
});
