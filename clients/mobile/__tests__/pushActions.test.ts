import {DEFAULT_ACTION_IDENTIFIER} from 'expo-notifications';

import {PUSH_ACTION} from '../src/push/contract';
import {parsePushEnvelope, threadRootId} from '../src/push/envelope';
import {handlePushResponse} from '../src/push/notifications';

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
    expect(result).toEqual({kind: 'decided', approved: true});
    expect(mockDecideApproval).toHaveBeenCalledWith(WS, APPROVAL, true, 'decision-1');
  });

  it('records a rejection', async () => {
    const result = await handlePushResponse(response(PUSH_ACTION.reject), {
      signedInWorkspaceId: WS,
    });
    expect(result).toEqual({kind: 'decided', approved: false});
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
    expect(result).toEqual({kind: 'decided', approved: true});
  });

  it('ignores an action identifier it does not know', async () => {
    const result = await handlePushResponse(response('momo.action.snooze'), {
      signedInWorkspaceId: WS,
    });
    expect(result.kind).toBe('ignored');
  });
});
