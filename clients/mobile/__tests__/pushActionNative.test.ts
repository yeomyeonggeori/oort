import {requireOptionalNativeModule} from 'expo-modules-core';
import {
  DEFAULT_ACTION_IDENTIFIER,
  dismissNotificationAsync,
  getPresentedNotificationsAsync,
} from 'expo-notifications';

import {PUSH_ACTION, PUSH_ACTION_NATIVE_MODULE} from '../src/push/contract';
import {approvalNotificationIds} from '../src/push/approvalNotifications';
import {parsePushEnvelope, pushPayloadOf} from '../src/push/envelope';
import {nativeApprovalHandlerAttached, nativeQueuedReplyStore} from '../src/push/native';
import {handlePushResponse} from '../src/push/notifications';
import {drainQueuedReplies} from '../src/push/queuedReplies';
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
const ME = '77777777-7777-4777-8777-777777777777';

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

describe('답장은 처리기가 **이 응답을 남겼을 때만** JS 가 보내지 않는다 (#6036 · #6092)', () => {
  const reply = () =>
    remote(
      PUSH_ACTION.quickReply,
      payload({aps: {category: 'momo.message'}, momo: {reason: 'dm', approval_id: undefined}}),
      '알겠어요',
    );
  const presented = getPresentedNotificationsAsync as unknown as jest.Mock;
  const dismiss = dismissNotificationAsync as unknown as jest.Mock;

  beforeEach(() => {
    presented.mockReset().mockResolvedValue([]);
    dismiss.mockClear();
  });

  /** 처리기가 `apns-1` 응답에 한 일을 말하는 모듈. */
  function handlerSaid(outcome: string | null, extra: Record<string, unknown> = {}) {
    nativeModules({
      handlesApprovalActions: true,
      handlesReplyActions: true,
      replyOutcome: (id: string) => (id === 'apns-1' ? outcome : null),
      ...extra,
    });
  }

  it('처리기가 남겼으면 물러난다 — 보내기는 보관 목록 한 길이다', async () => {
    handlerSaid('kept');

    const result = await handlePushResponse(reply(), {signedInWorkspaceId: WS});

    expect(result).toEqual({kind: 'ignored', reason: 'replies are kept natively and sent from the list'});
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockSendThreadReply).not.toHaveBeenCalled();
  });

  // r1 M1 ㉯: 고치기 전 JS 는 「지금 남기는가」(세션 항목을 새로 읽음)를 물었다. 토큰을 새로 놓는 틈(지우고 → 쓰기)에 물으면
  // 처리기가 이미 남긴 답장을 JS 도 보냈다(다른 열쇠 → 두 행). 이 모듈은 그 옛 물음에 「아니오」를 답하지만, 처리기는 남겼다.
  it('처리기가 남긴 뒤 세션 항목이 잠깐 비어 있어도(토큰 다시 놓기) 보내지 않는다', async () => {
    handlerSaid('kept', {keepsRepliesNow: () => false});

    const result = await handlePushResponse(reply(), {signedInWorkspaceId: WS});

    expect(result.kind).toBe('ignored');
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  // r1 M1 ㉮: 처리기가 남기지 못해 「답장을 보내지 못했어요」를 올린 응답을 JS 가 보냈는데 그 줄이 남았다.
  it('처리기가 남기지 못했으면 JS 가 보내고, 처리기가 올린 「보내지 못했어요」 줄을 걷는다', async () => {
    handlerSaid('notKept', {keepsRepliesNow: () => true});
    presented.mockResolvedValue([
      {request: {identifier: 'apns-1', content: {categoryIdentifier: null}}},
    ]);

    const result = await handlePushResponse(reply(), {signedInWorkspaceId: WS});

    expect(result).toEqual({kind: 'replied'});
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(dismiss).toHaveBeenCalledWith('apns-1');
  });

  it('그 식별자에 새 메시지 알림이 와 있으면(범주 있음) 걷지 않는다 — 우리 줄만 걷는다', async () => {
    handlerSaid('notKept');
    presented.mockResolvedValue([
      {request: {identifier: 'apns-1', content: {categoryIdentifier: 'momo.message'}}},
    ]);

    await handlePushResponse(reply(), {signedInWorkspaceId: WS});

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('보내기가 실패하면 「보내지 못했어요」 줄을 그대로 둔다', async () => {
    handlerSaid('notKept');
    presented.mockResolvedValue([{request: {identifier: 'apns-1', content: {categoryIdentifier: null}}}]);
    mockSendMessage.mockRejectedValueOnce(new TypeError('Network request failed'));

    const result = await handlePushResponse(reply(), {signedInWorkspaceId: WS});

    expect(result.kind).toBe('failed');
    expect(dismiss).not.toHaveBeenCalled();
  });

  it.each([
    ['옛 모듈이라 상수가 없다', {handlesApprovalActions: true}],
    ['상수가 불리언이 아니다', {handlesApprovalActions: true, handlesReplyActions: 'yes', replyOutcome: () => 'kept'}],
    ['처리기가 이 응답을 받은 적이 없다', {handlesApprovalActions: true, handlesReplyActions: true, replyOutcome: () => null}],
    ['모르는 답', {handlesApprovalActions: true, handlesReplyActions: true, replyOutcome: () => 'maybe'}],
    ['묻는 함수가 없다', {handlesApprovalActions: true, handlesReplyActions: true}],
  ])('%s: 예전처럼 JS 가 보내고 아무 줄도 걷지 않는다 (대조군)', async (_name, module) => {
    nativeModules(module);

    const result = await handlePushResponse(reply(), {signedInWorkspaceId: WS});

    expect(result).toEqual({kind: 'replied'});
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(dismiss).not.toHaveBeenCalled();
  });
});

describe('처리기가 남긴 직후 JS 가 묻는 차례를 바꿔도 서버에는 한 행이다 (#6092 수용 기준 2)', () => {
  // 서버: 같은 (채널, 작성자, 열쇠)는 한 행이다(`message_client_idem_uniq`). 행 수 = 서로 다른 열쇠의 수.
  const rows = () => new Set(mockSendMessage.mock.calls.map(call => call[2] as string)).size;
  const response = () =>
    remote(
      PUSH_ACTION.quickReply,
      payload({aps: {category: 'momo.message'}, momo: {reason: 'dm', approval_id: undefined}}),
      '알겠어요',
    );

  /** 처리기가 한 일: 남겼으면 목록에 항목 하나와 「kept」, 아니면 「notKept」. 그 뒤 세션 항목이 잠깐 비는 틈도 흉내 낸다. */
  function phone(kept: boolean) {
    const list = new Map<string, string>();
    if (kept) {
      list.set(
        'aaaaaaaa-0000-4000-8000-00000000000a',
        JSON.stringify({
          v: 1,
          clientMsgId: 'aaaaaaaa-0000-4000-8000-00000000000a',
          workspaceID: WS,
          memberID: ME,
          text: '알겠어요',
          requestIdentifier: 'apns-1',
          origin: JSON.stringify(
            payload({aps: {category: 'momo.message'}, momo: {reason: 'dm', approval_id: undefined}}),
          ),
          createdAtMs: Date.now() - 1_000,
        }),
      );
    }
    nativeModules({
      handlesApprovalActions: true,
      handlesReplyActions: true,
      replyOutcome: (id: string) => (id === 'apns-1' ? (kept ? 'kept' : 'notKept') : null),
      // 옛 물음(「지금 남기는가」)에는 토큰을 다시 놓는 틈이라 반대로 답한다 — 고치기 전 코드가 이것을 물었다.
      keepsRepliesNow: () => !kept,
      queuedReplies: () => [...list.values()],
      removeQueuedReply: (id: string) => void list.delete(id),
      markQueuedReplyRefused: () => true,
      clearQueuedReplies: () => list.clear(),
    });
    return list;
  }

  async function drain() {
    await drainQueuedReplies({
      workspaceId: WS,
      memberId: ME,
      isCurrent: () => true,
      copy: {drafted: 'd', notSentTitle: 't', notSentBody: 'b'},
    }, {
      store: nativeQueuedReplyStore(),
      send: async (queued, envelope) => {
        await mockSendMessage(envelope.workspaceId, envelope.channelId, queued.clientMsgId, queued.text);
      },
      now: Date.now,
      notify: async () => {},
      dismiss: async () => {},
    });
  }

  it.each([
    ['남김 → JS 가 묻고 → 비우기', true, 'ask-first'],
    ['남김 → 비우기가 먼저 보내고 지움 → JS 가 물음', true, 'drain-first'],
    ['못 남김 → JS 가 묻고 → 비우기', false, 'ask-first'],
    ['못 남김 → 비우기 → JS 가 물음', false, 'drain-first'],
  ])('%s: 서버 1행', async (_name, kept, order) => {
    const list = phone(kept as boolean);
    mockSendMessage.mockResolvedValue({id: 'm'});

    if (order === 'ask-first') {
      await handlePushResponse(response(), {signedInWorkspaceId: WS});
      await drain();
    } else {
      await drain();
      await handlePushResponse(response(), {signedInWorkspaceId: WS});
    }

    expect(rows()).toBe(1);
    expect(list.size).toBe(0);
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

// =============================================================================
// 결정된 승인의 알림 걷기(#3926 `approvalNotifications.ts`)가 처리기의 결과 줄도 알아본다.
//
// 처리기가 올린 줄은 로컬 알림이라 푸시 트리거가 없고 원문이 `content.data.origin` 에 있다. 걷기가
// 트리거의 원문만 읽으면 실패 줄(「…마무리해 주세요」)이 앱에서 마무리한 뒤에도 잠금 화면에 남는다.
// =============================================================================
describe('결정된 승인의 알림 걷기는 결과 줄도 그 승인의 것으로 안다', () => {
  const OTHER_APPROVAL = '66666666-6666-4666-8666-666666666666';

  /** 알림 센터에 배달된 알림: `getPresentedNotificationsAsync` 가 돌려주는 모양. */
  const delivered = (identifier: string, request: {trigger: unknown; data?: unknown}) =>
    ({
      date: 0,
      request: {identifier, content: {title: 't', data: request.data ?? null}, trigger: request.trigger},
    }) as never;

  it('트리거 없는 결과 줄이 content.data.origin 으로 그 승인에 묶이고, 다른 승인의 줄은 그대로다', () => {
    const center = [
      delivered('push-1', {trigger: {type: 'push', payload: payload()}}),
      delivered('result-line', {trigger: null, data: {origin: payload()}}),
      delivered('other-approval-line', {
        trigger: null,
        data: {origin: payload({momo: {approval_id: OTHER_APPROVAL}})},
      }),
      delivered('message-line', {
        trigger: null,
        data: {origin: payload({aps: {category: 'momo.message'}, momo: {reason: 'dm', approval_id: undefined}})},
      }),
    ];

    expect(approvalNotificationIds(center, APPROVAL)).toEqual(['push-1', 'result-line']);
  });

  it('원격 푸시는 트리거의 원문만 본다 — content.data.origin 으로 다른 승인의 것인 척할 수 없다', () => {
    const center = [
      delivered('spoof', {
        trigger: {type: 'push', payload: payload({momo: {approval_id: OTHER_APPROVAL}})},
        data: {origin: payload()},
      }),
    ];

    expect(approvalNotificationIds(center, APPROVAL)).toEqual([]);
  });

  it('원문이 없는 줄은 걷지 않는다 (무엇인지 모르는 것을 지우지 않는다)', () => {
    expect(approvalNotificationIds([delivered('bare', {trigger: null})], APPROVAL)).toEqual([]);
    expect(approvalNotificationIds([delivered('junk', {trigger: null, data: {origin: 42}})], APPROVAL)).toEqual([]);
  });
});
