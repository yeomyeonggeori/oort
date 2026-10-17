import {requireOptionalNativeModule} from 'expo-modules-core';
import {DEFAULT_ACTION_IDENTIFIER} from 'expo-notifications';

import {PUSH_ACTION, PUSH_ACTION_NATIVE_MODULE} from '../src/push/contract';
import {parsePushEnvelope, pushPayloadOf} from '../src/push/envelope';
import {nativeApprovalHandlerAttached} from '../src/push/native';
import {handlePushResponse} from '../src/push/notifications';
import {tapArrival} from '../src/push/tapArrival';

// =============================================================================
// #3931 (ADR-0204 D6) — 잠금 화면의 승인·거절은 iOS 에서 **네이티브 처리기가 혼자** 맡는다.
//
// 이 파일은 JS 쪽 절반이다: 처리기가 붙어 있으면 `handlePushResponse` 는 두 버튼에서 물러난다
// (두 번 결정하지 않으려고), 답장은 그대로 한다, 그리고 처리기가 승인 알림을 대신해 올리는
// 한 줄짜리 로컬 알림을 눌러도 카드로 간다.
//
// 「물러난다」는 처리기가 **붙어 있을 때만**이다. 모듈이 없는 빌드(시험, 옛 바이너리 위의 새
// JS)나 `install()` 이 불리지 않은 시작 경로에서 물러나면 버튼이 소리 없이 죽는다 — 그
// 반대편(대조군)을 아래에서 같이 잰다. 단정이 헛돌지 않게.
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
  uuidEq: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(),
}));

const requireNative = requireOptionalNativeModule as unknown as jest.Mock;

/** 이 빌드의 네이티브 모듈들이 말하는 것. `MomoPushAction` 만 바꾼다. */
function nativeModules(action: Record<string, unknown> | null) {
  requireNative.mockImplementation((name: string) =>
    name === PUSH_ACTION_NATIVE_MODULE ? action : null,
  );
}

function payload(overrides: {aps?: object; momo?: object; workspace?: string} = {}) {
  return {
    aps: {badge: 1, 'thread-id': CHANNEL, category: 'momo.approval', ...overrides.aps},
    momo: {
      schema: 'momo.push.notification.v2',
      server_id: 'srv-1',
      workspace_id: overrides.workspace ?? WS,
      channel_id: CHANNEL,
      message_id: MESSAGE,
      collapse_id: 'collapse-1',
      reason: 'approval_request',
      approval_id: APPROVAL,
      ...overrides.momo,
    },
  };
}

/** 원격 푸시로 온 응답: 푸시 트리거가 원문을 든다. */
function remote(actionIdentifier: string, body = payload(), userText?: string) {
  return {
    actionIdentifier,
    userText,
    notification: {
      date: 1,
      request: {identifier: 'apns-1', content: {title: '그록봇', data: null}, trigger: {type: 'push', payload: body}},
    },
  } as never;
}

/** 처리기가 대신 올린 한 줄짜리 로컬 알림: 트리거가 없고 원문은 `content.data.origin` 에 있다. */
function resultLine(actionIdentifier = DEFAULT_ACTION_IDENTIFIER, origin: unknown = payload()) {
  return {
    actionIdentifier,
    notification: {
      date: 2,
      request: {
        identifier: 'apns-1',
        content: {title: '승인했어요 · 그록봇', body: null, data: {origin}},
        trigger: null,
      },
    },
  } as never;
}

beforeEach(() => {
  mockDecideApproval.mockReset().mockResolvedValue({kind: 'committed'});
  mockSendMessage.mockReset().mockResolvedValue({});
  mockSendThreadReply.mockReset().mockResolvedValue({});
  nativeModules(null);
});

afterEach(() => {
  requireNative.mockReset().mockReturnValue(null);
});

describe('처리기가 붙어 있으면 JS 는 승인·거절에서 물러난다', () => {
  beforeEach(() => nativeModules({handlesApprovalActions: true}));

  it.each([
    ['승인', PUSH_ACTION.approve],
    ['거절', PUSH_ACTION.reject],
  ])('%s: 결정을 보내지 않는다', async (_name, action) => {
    const result = await handlePushResponse(remote(action), {signedInWorkspaceId: WS});

    expect(result).toEqual({kind: 'ignored', reason: 'approval buttons are answered natively'});
    expect(mockDecideApproval).not.toHaveBeenCalled();
  });

  it('다른 워크스페이스의 알림도, 읽을 수 없는 봉투도 같은 이유로 물러난다 (네이티브가 판정한다)', async () => {
    const other = await handlePushResponse(remote(PUSH_ACTION.approve, payload({workspace: OTHER_WS})), {
      signedInWorkspaceId: WS,
    });
    const unreadable = await handlePushResponse(remote(PUSH_ACTION.approve, {} as never), {
      signedInWorkspaceId: WS,
    });

    expect(other).toEqual({kind: 'ignored', reason: 'approval buttons are answered natively'});
    expect(unreadable).toEqual({kind: 'ignored', reason: 'approval buttons are answered natively'});
    expect(mockDecideApproval).not.toHaveBeenCalled();
  });

  it('답장은 그대로 JS 가 보낸다', async () => {
    const result = await handlePushResponse(
      remote(PUSH_ACTION.quickReply, payload({aps: {category: 'momo.message'}, momo: {reason: 'dm', approval_id: undefined}}), '알겠어요'),
      {signedInWorkspaceId: WS},
    );

    expect(result).toEqual({kind: 'replied'});
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage.mock.calls[0][3]).toBe('알겠어요');
  });

  it('본문 탭은 그대로 열린다', async () => {
    const result = await handlePushResponse(remote(DEFAULT_ACTION_IDENTIFIER), {signedInWorkspaceId: WS});

    expect(result.kind).toBe('opened');
  });
});

describe('처리기가 붙어 있지 않으면 JS 가 예전처럼 한다 (대조군 — 위의 「보내지 않는다」가 헛돌지 않게)', () => {
  it.each([
    ['모듈이 없다', null],
    ['모듈은 있는데 처리기가 아직 안 붙었다', {handlesApprovalActions: false}],
    ['옛 모듈이라 상수가 없다', {}],
    ['상수가 불리언이 아니다', {handlesApprovalActions: 'yes'}],
  ])('%s: 결정을 보낸다', async (_name, action) => {
    nativeModules(action as Record<string, unknown> | null);

    const result = await handlePushResponse(remote(PUSH_ACTION.approve), {signedInWorkspaceId: WS});

    expect(nativeApprovalHandlerAttached()).toBe(false);
    expect(result).toEqual({kind: 'decided', approved: true, record: 'pressed'});
    expect(mockDecideApproval).toHaveBeenCalledWith(WS, APPROVAL, true, 'decision-1');
  });

  it('붙어 있다는 대답은 true 하나뿐이다', () => {
    nativeModules({handlesApprovalActions: true});

    expect(nativeApprovalHandlerAttached()).toBe(true);
  });
});

describe('처리기가 올린 한 줄짜리 로컬 알림을 누르면 카드로 간다', () => {
  it('원문은 푸시 트리거가 아니라 content.data.origin 에서 읽는다', () => {
    expect(pushPayloadOf(resultLine())).toEqual(payload());
    expect(parsePushEnvelope(pushPayloadOf(resultLine()))?.approvalId).toBe(APPROVAL);
  });

  it('본문 탭은 그 승인 카드를 가리킨다 (성공 줄도, 실패 줄도 같은 원문을 든다)', () => {
    const arrival = tapArrival(resultLine(), WS);

    expect(arrival).toEqual({
      kind: 'target',
      target: {
        channelId: CHANNEL,
        messageId: MESSAGE,
        threadRootId: null,
        approvalId: APPROVAL,
        category: 'momo.approval',
        reason: 'approval_request',
      },
    });
  });

  it('다른 워크스페이스의 줄은 「못 간다」다', () => {
    expect(tapArrival(resultLine(DEFAULT_ACTION_IDENTIFIER, payload({workspace: OTHER_WS})), WS)).toEqual({
      kind: 'unavailable',
      reason: 'other-workspace',
    });
  });

  it('원문이 없거나 읽을 수 없는 줄은 조용히 넘기지 않고 「읽지 못했다」다', () => {
    // 원문이 null 이다(기본값이 undefined 를 삼키므로 null 로 건넨다).
    expect(tapArrival(resultLine(DEFAULT_ACTION_IDENTIFIER, null), WS)).toEqual({
      kind: 'unavailable',
      reason: 'unreadable',
    });
    // content.data 자체가 없다.
    const noData = {
      actionIdentifier: DEFAULT_ACTION_IDENTIFIER,
      notification: {date: 2, request: {identifier: 'x', content: {title: 't', data: null}, trigger: null}},
    } as never;
    expect(tapArrival(noData, WS)).toEqual({kind: 'unavailable', reason: 'unreadable'});
    expect(tapArrival(resultLine(DEFAULT_ACTION_IDENTIFIER, {momo: {}}), WS)).toEqual({
      kind: 'unavailable',
      reason: 'unreadable',
    });
  });

  it('원격 푸시의 원문이 있으면 content.data.origin 은 보지 않는다 — 원격 입력이 로컬 입력으로 둔갑하지 못한다', () => {
    const response = {
      actionIdentifier: DEFAULT_ACTION_IDENTIFIER,
      notification: {
        date: 1,
        request: {
          identifier: 'apns-1',
          content: {title: 'x', data: {origin: payload({workspace: OTHER_WS})}},
          trigger: {type: 'push', payload: payload()},
        },
      },
    } as never;

    expect(pushPayloadOf(response)).toEqual(payload());
    expect(tapArrival(response, WS)?.kind).toBe('target');
  });
});
