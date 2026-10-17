import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import * as Notifications from 'expo-notifications';
import React from 'react';

import '../src/boot/polyfills';

import {ApprovalDecision} from '../src/features/inbox/ApprovalDecision';
import {SessionProvider} from '../src/session/useSession';

// =============================================================================
// 앱 안에서 승인을 결정하면 그 승인의 알림이 걷힌다 (#3926, ADR-0204 D6 마지막 줄).
//
// 인박스 행과 타임라인 카드는 모두 이 컨트롤(`ApprovalDecision`)로 결정한다. 그래서 걷는
// 일은 여기 한 곳에 걸려 있고, 이 파일은 그 한 곳을 잰다.
//   · 기록된 결정(`committed`)도, 이미 결정돼 있던 것(`superseded`)도 그 승인의 알림만 걷는다.
//   · 오류는 걷지 않는다: 승인은 여전히 대기라 알림이 남아 있어야 한다.
//   · 알림 센터가 고장나도 화면은 결정을 알게 된다(`onSettled`는 그대로 불린다).
// =============================================================================

const mockDecide = jest.fn();
jest.mock('@momo/core/features/timeline/approvalDecision', () => {
  const actual = jest.requireActual('@momo/core/features/timeline/approvalDecision');
  return {...actual, decideApproval: (...args: unknown[]) => mockDecide(...args)};
});

const mockPresented = jest.mocked(Notifications.getPresentedNotificationsAsync);
const mockDismiss = jest.mocked(Notifications.dismissNotificationAsync);

const WS = '11111111-1111-4111-8111-111111111111';
const CHANNEL = '33333333-3333-4333-8333-333333333333';
const MESSAGE = '44444444-4444-4444-8444-444444444444';
// 16진 문자가 든 id여야 대문자 시험이 의미가 있다(숫자뿐이면 `toUpperCase()`가 그대로다).
const APPROVAL = '5555abcd-5555-4555-8555-55555555ef01';
const OTHER_APPROVAL = '6666abcd-6666-4666-8666-66666666ef02';
const ME = {id: '77777777-7777-4777-8777-777777777777', workspaceId: WS, displayName: '곽성재'} as Member;

function envelope(approvalId: string) {
  return {
    aps: {badge: 1, 'thread-id': CHANNEL, category: 'momo.approval'},
    momo: {
      schema: 'momo.push.notification.v2',
      server_id: 'srv-1',
      workspace_id: WS,
      channel_id: CHANNEL,
      message_id: MESSAGE,
      collapse_id: 'collapse-1',
      reason: 'approval_request',
      approval_id: approvalId,
    },
  };
}

function delivered(identifier: string, approvalId: string) {
  return {
    date: 0,
    request: {
      identifier,
      content: {},
      trigger: {type: 'push', payload: envelope(approvalId)},
    },
  } as unknown as Notifications.Notification;
}

function draw(approvalId: string, onSettled: jest.Mock) {
  const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}});
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider member={ME}>
        <ApprovalDecision approvalId={approvalId} onSettled={onSettled} />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

async function press(testID: string) {
  await act(async () => {
    fireEvent.press(screen.getByTestId(testID));
  });
}

function dismissedIds(): string[] {
  return mockDismiss.mock.calls.map(([identifier]) => identifier);
}

beforeEach(() => {
  mockDecide.mockReset().mockResolvedValue({kind: 'committed', status: 'approved'});
  mockPresented
    .mockReset()
    .mockResolvedValue([
      delivered('this-approval', APPROVAL),
      delivered('other-approval', OTHER_APPROVAL),
    ]);
  mockDismiss.mockReset().mockResolvedValue(undefined);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

describe('앱 안 결정이 끝나면 그 승인의 알림이 걷힌다', () => {
  it('승인이 기록되면 그 승인의 알림만 걷는다', async () => {
    const onSettled = jest.fn();
    draw(APPROVAL, onSettled);

    await press('inbox-approval-approve');

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(dismissedIds()).toEqual(['this-approval']);
  });

  it('거부가 기록돼도 같다', async () => {
    mockDecide.mockResolvedValue({kind: 'committed', status: 'rejected'});
    draw(APPROVAL, jest.fn());

    await press('inbox-approval-reject');

    expect(dismissedIds()).toEqual(['this-approval']);
  });

  it('원장의 대문자 id로 결정해도 소문자 봉투의 알림을 찾는다', async () => {
    draw(APPROVAL.toUpperCase(), jest.fn());

    await press('inbox-approval-approve');

    expect(dismissedIds()).toEqual(['this-approval']);
  });

  it('다른 곳에서 이미 결정돼 있었어도(superseded) 걷는다', async () => {
    mockDecide.mockResolvedValue({
      kind: 'superseded',
      status: 'approved',
      note: '다른 곳에서 이미 결정됐어요.',
    });
    const onSettled = jest.fn();
    draw(APPROVAL, onSettled);

    await press('inbox-approval-reject');

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(dismissedIds()).toEqual(['this-approval']);
  });

  it('결정이 기록되지 않았으면(오류) 걷지 않는다', async () => {
    mockDecide.mockResolvedValue({kind: 'error', errorCopy: '서버에 닿지 못했어요.'});
    const onSettled = jest.fn();
    draw(APPROVAL, onSettled);

    await press('inbox-approval-approve');

    expect(onSettled).not.toHaveBeenCalled();
    expect(mockPresented).not.toHaveBeenCalled();
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it('알림 센터를 읽지 못해도 화면은 결정을 알게 된다', async () => {
    mockPresented.mockRejectedValue(new Error('native module unavailable'));
    const onSettled = jest.fn();
    draw(APPROVAL, onSettled);

    await press('inbox-approval-approve');

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(mockDismiss).not.toHaveBeenCalled();
  });
});
