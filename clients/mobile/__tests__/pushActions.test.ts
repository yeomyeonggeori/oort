import * as Notifications from 'expo-notifications';
import {DEFAULT_ACTION_IDENTIFIER} from 'expo-notifications';

import {PUSH_ACTION} from '../src/push/contract';
import {parsePushEnvelope, threadRootId} from '../src/push/envelope';
import {
  decideFromNotification,
  handlePushResponse,
} from '../src/push/notifications';

// =============================================================================
// The fourth step of the loop ADR-0120 D2-A describes: id-only -> fetch ->
// display -> ACT FROM THE NOTIFICATION.
//
// The first three run in Swift inside the extension. This one runs here, and it
// is the half the 2026-08-02 audit found did NOT survive the port as code
// (§2.2): the frozen kit spent 678 lines on it across four files bound to
// MomoCore and UIKit. Rewritten in JS it is small — which is exactly why the
// guards it used to carry have to be tested rather than assumed.
// =============================================================================

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '22222222-2222-4222-8222-222222222222';
const CHANNEL = '33333333-3333-4333-8333-333333333333';
const MESSAGE = '44444444-4444-4444-8444-444444444444';
const APPROVAL = '55555555-5555-4555-8555-555555555555';

// `mock`-prefixed by necessity, not style: jest hoists `jest.mock` factories
// above the file's own declarations and rejects any other out-of-scope name.
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

function payload(overrides: {aps?: object; momo?: object} = {}) {
  return {
    aps: {
      badge: 1,
      'thread-id': CHANNEL,
      category: 'momo.approval',
      ...overrides.aps,
    },
    momo: {
      schema: 'momo.push.notification.v2',
      server_id: 'srv-1',
      workspace_id: WS,
      channel_id: CHANNEL,
      message_id: MESSAGE,
      collapse_id: 'collapse-1',
      reason: 'approval_request',
      approval_id: APPROVAL,
      ...overrides.momo,
    },
  };
}

function response(actionIdentifier: string, body = payload(), userText?: string) {
  return {
    actionIdentifier,
    userText,
    notification: {request: {trigger: {type: 'push', payload: body}}},
  } as never;
}

beforeEach(() => {
  mockDecideApproval.mockReset().mockResolvedValue({kind: 'committed'});
  mockSendMessage.mockReset().mockResolvedValue({});
  mockSendThreadReply.mockReset().mockResolvedValue({});
});

describe('envelope guards mirror the extension', () => {
  it('accepts a well-formed approval payload', () => {
    const envelope = parsePushEnvelope(payload());
    expect(envelope?.approvalId).toBe(APPROVAL);
    expect(envelope?.category).toBe('momo.approval');
  });

  it('rejects a payload whose schema is not exactly v2', () => {
    // The extension compares with ==, so a v3 payload it cannot understand must
    // not be half-understood here either.
    expect(
      parsePushEnvelope(payload({momo: {schema: 'momo.push.notification.v3'}})),
    ).toBeNull();
  });

  it('rejects non-UUID identifiers', () => {
    expect(parsePushEnvelope(payload({momo: {channel_id: 'not-a-uuid'}}))).toBeNull();
  });

  it('accepts the 「작업 끝남」 reason on the work category (ADR-0120 부록 A)', () => {
    // The fifth reason. Without it the JS guard drops a push the relay and the
    // extension both accept, and a tap does nothing.
    const envelope = parsePushEnvelope(
      payload({
        aps: {category: 'momo.work'},
        momo: {reason: 'work_session_idle', approval_id: undefined},
      }),
    );
    expect(envelope?.reason).toBe('work_session_idle');
    expect(envelope?.category).toBe('momo.work');
    expect(envelope?.approvalId).toBeNull();
  });

  it('rejects an unknown reason', () => {
    expect(parsePushEnvelope(payload({momo: {reason: 'because'}}))).toBeNull();
  });

  it('rejects an approval category with no approval id', () => {
    expect(parsePushEnvelope(payload({momo: {approval_id: undefined}}))).toBeNull();
  });

  it('rejects an approval id riding on a non-approval category', () => {
    // The dangerous direction: a plain message carrying an approval id that some
    // later branch might act on.
    expect(
      parsePushEnvelope(
        payload({aps: {category: 'momo.message'}, momo: {reason: 'dm'}}),
      ),
    ).toBeNull();
  });

  it('reports no thread root when the thread is the channel itself', () => {
    const envelope = parsePushEnvelope(payload())!;
    expect(threadRootId(envelope)).toBeNull();
  });
});

describe('notification actions', () => {
  it('records an approval', async () => {
    const result = await handlePushResponse(response(PUSH_ACTION.approve), {
      signedInWorkspaceId: WS,
    });
    expect(result).toEqual({kind: 'decided', approved: true, record: 'pressed'});
    expect(mockDecideApproval).toHaveBeenCalledWith(WS, APPROVAL, true, 'decision-1');
  });

  it('records a rejection', async () => {
    const result = await handlePushResponse(response(PUSH_ACTION.reject), {
      signedInWorkspaceId: WS,
    });
    expect(result).toEqual({kind: 'decided', approved: false, record: 'pressed'});
    expect(mockDecideApproval).toHaveBeenCalledWith(WS, APPROVAL, false, 'decision-1');
  });

  it('REFUSES to act on a push from another workspace', async () => {
    // The invariant the frozen kit checked in three separate layers. A stale
    // notification for a workspace the person has left must never drive a write
    // into the one they are in now.
    const result = await handlePushResponse(response(PUSH_ACTION.approve), {
      signedInWorkspaceId: OTHER_WS,
    });
    expect(result).toEqual({kind: 'ignored', reason: 'workspace mismatch'});
    expect(mockDecideApproval).not.toHaveBeenCalled();
  });

  it('treats a body tap as "open", never as an action', async () => {
    const result = await handlePushResponse(
      response(DEFAULT_ACTION_IDENTIFIER),
      {signedInWorkspaceId: WS},
    );
    expect(result.kind).toBe('opened');
    expect(mockDecideApproval).not.toHaveBeenCalled();
  });

  it('opens rather than throwing when the envelope is unreadable', async () => {
    const result = await handlePushResponse(
      {
        actionIdentifier: DEFAULT_ACTION_IDENTIFIER,
        notification: {request: {trigger: null}},
      } as never,
      {signedInWorkspaceId: WS},
    );
    expect(result).toEqual({kind: 'opened', envelope: null});
  });

  it('sends a quick reply to the channel', async () => {
    const body = payload({
      aps: {category: 'momo.message'},
      momo: {reason: 'dm', approval_id: undefined},
    });
    const result = await handlePushResponse(
      response(PUSH_ACTION.quickReply, body, '  다녀왔습니다  '),
      {signedInWorkspaceId: WS},
    );
    expect(result).toEqual({kind: 'replied'});
    expect(mockSendMessage).toHaveBeenCalledWith(
      WS,
      CHANNEL,
      expect.any(String),
      '다녀왔습니다',
    );
  });

  it('sends a whitespace-only reply nowhere', async () => {
    const body = payload({
      aps: {category: 'momo.message'},
      momo: {reason: 'dm', approval_id: undefined},
    });
    const result = await handlePushResponse(
      response(PUSH_ACTION.quickReply, body, '   '),
      {signedInWorkspaceId: WS},
    );
    expect(result).toEqual({kind: 'ignored', reason: 'empty reply'});
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('replies into the thread when the push came from one', async () => {
    const THREAD = '66666666-6666-4666-8666-666666666666';
    const body = payload({
      aps: {category: 'momo.mention', 'thread-id': THREAD},
      momo: {reason: 'mention', approval_id: undefined},
    });
    await handlePushResponse(
      response(PUSH_ACTION.quickReply, body, 'ok'),
      {signedInWorkspaceId: WS},
    );
    expect(mockSendThreadReply).toHaveBeenCalledWith(
      WS,
      CHANNEL,
      THREAD,
      expect.any(String),
      'ok',
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('surfaces a failed decision instead of reporting success', async () => {
    mockDecideApproval.mockResolvedValue({kind: 'error', errorCopy: '서버가 응답하지 않았습니다.'});
    const result = await handlePushResponse(response(PUSH_ACTION.approve), {
      signedInWorkspaceId: WS,
    });
    expect(result).toEqual({
      kind: 'failed',
      reason: '서버가 응답하지 않았습니다.',
    });
  });

  it('treats a superseded decision as settled, not failed', async () => {
    // Decided on another device, or expired. Retrying cannot change it.
    mockDecideApproval.mockResolvedValue({kind: 'superseded'});
    const result = await handlePushResponse(response(PUSH_ACTION.approve), {
      signedInWorkspaceId: WS,
    });
    expect(result).toEqual({kind: 'decided', approved: true, record: 'settled'});
  });

  it('does NOT report the tapped direction when the ledger holds the other one', async () => {
    // goal M-AP1 2R H5. 잠금화면에서 거부를 눌렀는데 원장에는 이미 승인이 적혀
    // 있는 경우다. 예전 코드는 두 갈래를 한 값에 접어 `{approved: false}` —
    // 사용자가 누른 방향 — 만 남겼고, 그래서 되돌릴 수 없는 축에서 화면이 **반대
    // 사실**을 말할 수 있었다. 누른 것과 기록된 것은 다른 사실이므로 따로 싣는다.
    mockDecideApproval.mockResolvedValue({
      kind: 'superseded',
      status: 'approved',
    });
    const result = await handlePushResponse(response(PUSH_ACTION.reject), {
      signedInWorkspaceId: WS,
    });
    expect(result).toEqual({
      kind: 'decided',
      approved: false,
      record: 'settled',
      recordedApproved: true,
    });
  });

  it('claims no direction at all when the ledger says it expired', async () => {
    mockDecideApproval.mockResolvedValue({
      kind: 'superseded',
      status: 'expired',
    });
    const result = await handlePushResponse(response(PUSH_ACTION.approve), {
      signedInWorkspaceId: WS,
    });
    expect(result).toEqual({kind: 'decided', approved: true, record: 'settled'});
    expect(result).not.toHaveProperty('recordedApproved');
  });

  it('ignores an action identifier it does not know', async () => {
    const result = await handlePushResponse(response('momo.action.snooze'), {
      signedInWorkspaceId: WS,
    });
    expect(result.kind).toBe('ignored');
  });
});

// =============================================================================
// 결정된 승인의 알림을 걷는다 (#3926, ADR-0204 D6 마지막 줄).
//
// 알림 버튼으로 결정하면 **그 승인의** 배달된 알림이 걷힌다 — 누른 알림 하나만이 아니라
// 같은 승인의 다른 알림까지, 그리고 다른 승인의 알림은 그대로. 결정이 기록되지 않았으면
// (오류) 걷지 않는다: 알림이 남아 있어야 사람이 다시 누르거나 앱에서 마무리할 수 있다.
// =============================================================================

const OTHER_APPROVAL = '66666666-6666-4666-8666-666666666666';

const mockPresented = jest.mocked(Notifications.getPresentedNotificationsAsync);
const mockDismiss = jest.mocked(Notifications.dismissNotificationAsync);

function delivered(identifier: string, body: unknown) {
  return {
    date: 0,
    request: {identifier, content: {}, trigger: {type: 'push', payload: body}},
  } as unknown as Notifications.Notification;
}

/** 알림 센터: 이 승인의 알림 둘, 다른 승인 하나, 메시지 하나. */
function notificationCenter() {
  return [
    delivered('tapped', payload()),
    delivered('other-approval', payload({momo: {approval_id: OTHER_APPROVAL}})),
    delivered('same-approval-again', payload()),
    delivered(
      'a-message',
      payload({
        aps: {category: 'momo.message'},
        momo: {reason: 'dm', approval_id: undefined},
      }),
    ),
  ];
}

function dismissedIds(): string[] {
  return mockDismiss.mock.calls.map(([identifier]) => identifier);
}

describe('decided approvals leave the notification centre', () => {
  beforeEach(() => {
    mockPresented.mockReset().mockResolvedValue(notificationCenter());
    mockDismiss.mockReset().mockResolvedValue(undefined);
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('dismisses every delivered notification of the approval it recorded, and nothing else', async () => {
    const result = await handlePushResponse(response(PUSH_ACTION.approve), {
      signedInWorkspaceId: WS,
    });

    expect(result).toEqual({kind: 'decided', approved: true, record: 'pressed'});
    expect(dismissedIds().sort()).toEqual(['same-approval-again', 'tapped']);
  });

  it('does the same for a rejection', async () => {
    await handlePushResponse(response(PUSH_ACTION.reject), {
      signedInWorkspaceId: WS,
    });

    expect(dismissedIds().sort()).toEqual(['same-approval-again', 'tapped']);
  });

  it('also dismisses when the ledger already held a decision (settled elsewhere)', async () => {
    mockDecideApproval.mockResolvedValue({kind: 'superseded', status: 'approved'});

    const result = await handlePushResponse(response(PUSH_ACTION.reject), {
      signedInWorkspaceId: WS,
    });

    expect(result).toEqual({
      kind: 'decided',
      approved: false,
      record: 'settled',
      recordedApproved: true,
    });
    expect(dismissedIds().sort()).toEqual(['same-approval-again', 'tapped']);
  });

  it('keeps the notifications when the decision was not recorded', async () => {
    mockDecideApproval.mockResolvedValue({kind: 'error', errorCopy: '서버가 응답하지 않았습니다.'});

    const result = await handlePushResponse(response(PUSH_ACTION.approve), {
      signedInWorkspaceId: WS,
    });

    expect(result.kind).toBe('failed');
    expect(mockPresented).not.toHaveBeenCalled();
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it('a notification centre that cannot be read does not undo a recorded decision', async () => {
    mockPresented.mockRejectedValue(new Error('native module unavailable'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await handlePushResponse(response(PUSH_ACTION.approve), {
      signedInWorkspaceId: WS,
    });

    expect(result).toEqual({kind: 'decided', approved: true, record: 'pressed'});
    warn.mockRestore();
  });

  it('leaves the notification centre alone for a body tap, a reply and another workspace', async () => {
    await handlePushResponse(response(DEFAULT_ACTION_IDENTIFIER), {
      signedInWorkspaceId: WS,
    });
    await handlePushResponse(
      response(
        PUSH_ACTION.quickReply,
        payload({
          aps: {category: 'momo.message'},
          momo: {reason: 'dm', approval_id: undefined},
        }),
        'ok',
      ),
      {signedInWorkspaceId: WS},
    );
    await handlePushResponse(response(PUSH_ACTION.approve), {
      signedInWorkspaceId: OTHER_WS,
    });

    expect(mockPresented).not.toHaveBeenCalled();
    expect(mockDismiss).not.toHaveBeenCalled();
  });
});

describe('decideFromNotification: the one function a native handler takes over', () => {
  beforeEach(() => {
    mockPresented.mockReset().mockResolvedValue(notificationCenter());
    mockDismiss.mockReset().mockResolvedValue(undefined);
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends the decision under the idempotency key its caller holds', async () => {
    await decideFromNotification(WS, APPROVAL, true, 'notification-request-key');

    expect(mockDecideApproval).toHaveBeenCalledWith(
      WS,
      APPROVAL,
      true,
      'notification-request-key',
    );
  });

  it('mints a key when the caller holds none', async () => {
    await decideFromNotification(WS, APPROVAL, false);

    expect(mockDecideApproval).toHaveBeenCalledWith(WS, APPROVAL, false, 'decision-1');
  });
});
