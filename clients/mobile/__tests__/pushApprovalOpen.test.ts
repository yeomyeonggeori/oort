import {DEFAULT_ACTION_IDENTIFIER} from 'expo-notifications';

import {PUSH_ACTION, PUSH_CATEGORY} from '../src/push/contract';
import {isLockScreenDecidable, parsePushEnvelope} from '../src/push/envelope';
import {handlePushResponse} from '../src/push/notifications';
import {tapArrival} from '../src/push/tapArrival';

// =============================================================================
// 잠금 화면이 결정하지 못하는 승인 — `momo.approval.open` (ADR-0204 D7, #3928).
//
// 서버는 두 승인 카테고리 중 하나를 고른다. `momo.approval`은 Face ID 뒤 잠금 화면에서
// 승인·거절하고, `momo.approval.open`은 「열어서 결정」 하나뿐이며 그 버튼이 앱을
// 열어 카드를 보여 준다(한 번만 보이는 비밀을 내는 승인, 호스트를 골라야 하는 실행).
//
// 이 파일이 지키는 것은 하나다: **open 승인은 승인의 이름을 달고 있어도 이 클라이언트가
// 알림에서 결정하지 않는다.** 그리고 「열어서 결정」은 본문 탭과 같은 탭이라 카드로 간다.
// 승인·거절 버튼 쪽(인라인 카테고리)은 `pushActions.test.ts`가 잰다.
// =============================================================================

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '22222222-2222-4222-8222-222222222222';
const CHANNEL = '33333333-3333-4333-8333-333333333333';
const MESSAGE = '44444444-4444-4444-8444-444444444444';
const APPROVAL = '55555555-5555-4555-8555-555555555555';

const mockDecideApproval = jest.fn();
const mockSendMessage = jest.fn();
const mockSendThreadReply = jest.fn();

jest.mock('@momo/core/features/timeline/approvalDecision', () => ({
  decideApproval: (...args: unknown[]) => mockDecideApproval(...args),
  newDecisionId: () => 'decision-1',
}));

jest.mock('@momo/core/lib/api', () => ({
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
  sendThreadReply: (...args: unknown[]) => mockSendThreadReply(...args),
}));

function payload(
  category: string = PUSH_CATEGORY.approvalOpen,
  momo: Record<string, unknown> = {},
) {
  return {
    aps: {badge: 1, 'thread-id': CHANNEL, category},
    momo: {
      schema: 'momo.push.notification.v2',
      server_id: 'srv-1',
      workspace_id: WS,
      channel_id: CHANNEL,
      message_id: MESSAGE,
      collapse_id: 'collapse-1',
      reason: 'approval_request',
      approval_id: APPROVAL,
      ...momo,
    },
  };
}

function response(actionIdentifier: string, body: unknown = payload()) {
  return {
    actionIdentifier,
    notification: {request: {trigger: {type: 'push', payload: body}}},
  } as never;
}

beforeEach(() => {
  mockDecideApproval.mockReset().mockResolvedValue({kind: 'committed'});
  mockSendMessage.mockReset().mockResolvedValue({});
  mockSendThreadReply.mockReset().mockResolvedValue({});
});

// =============================================================================
describe('봉투 — 두 승인 카테고리는 승인의 이름을 달고, 다른 카테고리는 달지 않는다', () => {
  it('open 승인은 승인 id 와 함께 읽힌다', () => {
    const envelope = parsePushEnvelope(payload());
    expect(envelope?.category).toBe('momo.approval.open');
    expect(envelope?.approvalId).toBe(APPROVAL);
    expect(envelope?.reason).toBe('approval_request');
  });

  it.each(Object.values(PUSH_CATEGORY))(
    '%s: 승인 id 가 있으면 승인 카테고리만, 없으면 승인 카테고리가 아닌 것만 읽힌다',
    category => {
      const carries =
        category === PUSH_CATEGORY.approval ||
        category === PUSH_CATEGORY.approvalOpen;
      const reason = carries ? 'approval_request' : 'mention';

      const withId = parsePushEnvelope(payload(category, {reason}));
      const withoutId = parsePushEnvelope(
        payload(category, {reason, approval_id: undefined}),
      );

      expect(withId !== null).toBe(carries);
      expect(withoutId !== null).toBe(!carries);
    },
  );

  it('알 수 없는 근접 카테고리는 읽히지 않는다 — 「승인처럼 생긴 것」으로 받지 않는다', () => {
    for (const near of [
      'momo.approval.opened',
      'momo.approval.',
      'momo.approvals',
      'momo.approval.OPEN',
    ]) {
      expect(parsePushEnvelope(payload(near))).toBeNull();
    }
  });
});

// =============================================================================
describe('알림에서 결정해도 되는가 — 인라인 승인 하나뿐이다', () => {
  it('momo.approval 만 결정할 수 있고, 나머지는 어느 것도 아니다', () => {
    const decidable = Object.values(PUSH_CATEGORY).filter(category => {
      const envelope = parsePushEnvelope(
        payload(category, {
          reason:
            category === PUSH_CATEGORY.approval ||
            category === PUSH_CATEGORY.approvalOpen
              ? 'approval_request'
              : 'mention',
          approval_id:
            category === PUSH_CATEGORY.approval ||
            category === PUSH_CATEGORY.approvalOpen
              ? APPROVAL
              : undefined,
        }),
      );
      return envelope !== null && isLockScreenDecidable(envelope);
    });
    expect(decidable).toEqual([PUSH_CATEGORY.approval]);
  });
});

// =============================================================================
describe('「열어서 결정」 응답은 본문 탭이다', () => {
  it('앱을 여는 일이 전부다 — 결정도 답장도 보내지 않는다', async () => {
    const result = await handlePushResponse(response(PUSH_ACTION.openApproval), {
      signedInWorkspaceId: WS,
    });

    expect(result.kind).toBe('opened');
    expect(result.kind === 'opened' && result.envelope?.approvalId).toBe(APPROVAL);
    expect(mockDecideApproval).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockSendThreadReply).not.toHaveBeenCalled();
  });

  it('본문 탭과 같은 결과를 낸다', async () => {
    const tapped = await handlePushResponse(response(DEFAULT_ACTION_IDENTIFIER), {
      signedInWorkspaceId: WS,
    });
    const opened = await handlePushResponse(response(PUSH_ACTION.openApproval), {
      signedInWorkspaceId: WS,
    });
    expect(opened).toEqual(tapped);
  });

  it('읽을 수 없는 봉투와 다른 워크스페이스의 알림도 열기만 한다 — 항법의 판정은 호출자 몫이다', async () => {
    const unreadable = await handlePushResponse(
      response(PUSH_ACTION.openApproval, {aps: {}, momo: {}}),
      {signedInWorkspaceId: WS},
    );
    expect(unreadable).toEqual({kind: 'opened', envelope: null});

    const elsewhere = await handlePushResponse(response(PUSH_ACTION.openApproval), {
      signedInWorkspaceId: OTHER_WS,
    });
    expect(elsewhere.kind).toBe('opened');
    expect(mockDecideApproval).not.toHaveBeenCalled();
  });
});

// =============================================================================
describe('open 승인에 승인·거절이 와도 결정하지 않는다 (보안 방어선)', () => {
  // 이 카테고리에는 승인·거절 버튼이 없다. 그래도 응답이 올 수 있다 — 카테고리가
  // 등록되기 전에 도착한 알림, 직접 만든 로컬 알림. 봉투가 승인 id 를 들고 있으므로
  // 막지 않으면 결정 경로가 그대로 돈다.
  it.each([PUSH_ACTION.approve, PUSH_ACTION.reject])('%s', async action => {
    const result = await handlePushResponse(response(action), {
      signedInWorkspaceId: WS,
    });

    expect(result).toEqual({
      kind: 'ignored',
      reason: 'this approval is decided in the app',
    });
    expect(mockDecideApproval).not.toHaveBeenCalled();
  });

  it('인라인 승인은 그대로 결정한다 — 방어선이 인라인까지 막지 않는다', async () => {
    const result = await handlePushResponse(
      response(PUSH_ACTION.approve, payload(PUSH_CATEGORY.approval)),
      {signedInWorkspaceId: WS},
    );

    expect(result).toEqual({kind: 'decided', approved: true, record: 'pressed'});
    expect(mockDecideApproval).toHaveBeenCalledWith(
      WS,
      APPROVAL,
      true,
      'decision-1',
    );
  });

  it('방어선은 워크스페이스 확인 뒤에 선다 — 다른 워크스페이스는 어느 쪽 이유로도 열리지 않는다', async () => {
    const result = await handlePushResponse(response(PUSH_ACTION.approve), {
      signedInWorkspaceId: OTHER_WS,
    });
    expect(result).toEqual({kind: 'ignored', reason: 'workspace mismatch'});
  });
});

// =============================================================================
describe('탭이 가리키는 곳 — 「열어서 결정」도 같은 카드로 간다', () => {
  it('본문 탭과 같은 목적지다: 카드 메시지, 승인 id, open 카테고리', () => {
    const body = tapArrival(response(DEFAULT_ACTION_IDENTIFIER), WS);
    const button = tapArrival(response(PUSH_ACTION.openApproval), WS);

    expect(button).toEqual(body);
    expect(button).toEqual({
      kind: 'target',
      target: {
        channelId: CHANNEL,
        messageId: MESSAGE,
        threadRootId: null,
        approvalId: APPROVAL,
        category: 'momo.approval.open',
        reason: 'approval_request',
      },
    });
  });

  it('승인·거절은 여전히 탭이 아니다 — open 카테고리에서도 항법을 만들지 않는다', () => {
    expect(tapArrival(response(PUSH_ACTION.approve), WS)).toBeNull();
    expect(tapArrival(response(PUSH_ACTION.reject), WS)).toBeNull();
    expect(tapArrival(response(PUSH_ACTION.quickReply), WS)).toBeNull();
  });

  it('다른 워크스페이스·읽을 수 없는 봉투는 「못 간다」다 — 조용히 앱만 열지 않는다', () => {
    expect(tapArrival(response(PUSH_ACTION.openApproval), OTHER_WS)).toEqual({
      kind: 'unavailable',
      reason: 'other-workspace',
    });
    expect(
      tapArrival(response(PUSH_ACTION.openApproval, {aps: {}, momo: {}}), WS),
    ).toEqual({kind: 'unavailable', reason: 'unreadable'});
  });
});
