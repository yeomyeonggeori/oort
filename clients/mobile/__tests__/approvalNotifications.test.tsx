import type {Approval} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, renderHook} from '@testing-library/react-native';
import * as Notifications from 'expo-notifications';
import React from 'react';

import {pendingApprovalsKey} from '../src/features/conversation/usePendingApprovals';
import {
  approvalNotificationIds,
  dismissApprovalNotifications,
} from '../src/push/approvalNotifications';
import {
  pendingApprovalIdSet,
  settledApprovalIds,
  useDismissSettledApprovalNotifications,
} from '../src/push/settledApprovalNotifications';

// =============================================================================
// 결정된 승인의 알림을 걷는다 (#3926, ADR-0204 D6 마지막 줄).
//
// 이 파일이 못박는 것은 한 문장이다: **그 승인의 알림만** 걷힌다. 다른 승인의 알림,
// 메시지·멘션·작업 알림, 봉투를 읽지 못하는 알림은 그대로 남는다. 걷는 동작
// (`dismissApprovalNotifications`)과, 그것을 「다른 곳의 결정」에 거는 관찰자
// (`useDismissSettledApprovalNotifications`)를 나눠서 잰다.
// =============================================================================

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '99999999-9999-4999-8999-999999999999';
const CHANNEL = '33333333-3333-4333-8333-333333333333';
const MESSAGE = '44444444-4444-4444-8444-444444444444';
// 16진 문자가 든 id여야 한다. 숫자뿐인 UUID는 `toUpperCase()`가 아무것도 바꾸지 않아서,
// 대소문자 비교를 깨뜨려도 통과하는 시험이 된다(사보타주로 확인했다).
const A1 = '5555abcd-5555-4555-8555-55555555ef01';
const A2 = '6666abcd-6666-4666-8666-66666666ef02';

const mockPresented = jest.mocked(Notifications.getPresentedNotificationsAsync);
const mockDismiss = jest.mocked(Notifications.dismissNotificationAsync);

function approvalPayload(approvalId: string) {
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

function messagePayload() {
  return {
    aps: {badge: 1, 'thread-id': CHANNEL, category: 'momo.message'},
    momo: {
      schema: 'momo.push.notification.v2',
      server_id: 'srv-1',
      workspace_id: WS,
      channel_id: CHANNEL,
      message_id: MESSAGE,
      collapse_id: 'collapse-2',
      reason: 'dm',
    },
  };
}

/** 알림 센터에 배달된 알림 하나. 모양은 `getPresentedNotificationsAsync`가 돌려주는 것. */
function delivered(identifier: string, payload: unknown, type = 'push') {
  return {
    date: 0,
    request: {
      identifier,
      content: {},
      trigger: payload === null ? null : {type, payload},
    },
  } as unknown as Notifications.Notification;
}

/** 알림 센터에 이 승인 둘, 다른 승인 하나, 메시지 하나, 읽을 수 없는 것들이 있다. */
function center(): Notifications.Notification[] {
  return [
    delivered('a1-first', approvalPayload(A1)),
    delivered('a2-only', approvalPayload(A2)),
    delivered('a1-second', approvalPayload(A1)),
    delivered('plain-message', messagePayload()),
    delivered('no-trigger', null),
    delivered('foreign', {aps: {category: 'other'}, someone: 'else'}),
    delivered(
      'wrong-schema',
      (() => {
        const payload = approvalPayload(A1);
        payload.momo.schema = 'momo.push.notification.v3';
        return payload;
      })(),
    ),
  ];
}

function dismissedIds(): string[] {
  return mockDismiss.mock.calls.map(([identifier]) => identifier);
}

beforeEach(() => {
  mockPresented.mockReset().mockResolvedValue([]);
  mockDismiss.mockReset().mockResolvedValue(undefined);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('approvalNotificationIds: 그 승인의 알림만', () => {
  it('이 승인의 알림 둘을 고르고, 다른 승인·메시지·읽을 수 없는 것은 고르지 않는다', () => {
    expect(approvalNotificationIds(center(), A1)).toEqual([
      'a1-first',
      'a1-second',
    ]);
    expect(approvalNotificationIds(center(), A2)).toEqual(['a2-only']);
  });

  it('원장의 대문자 id로 물어도 같은 승인이다', () => {
    expect(approvalNotificationIds(center(), A1.toUpperCase())).toEqual([
      'a1-first',
      'a1-second',
    ]);
  });

  it('알림 센터에 그 승인이 없으면 비어 있다', () => {
    expect(
      approvalNotificationIds(center(), '77777777-7777-4777-8777-777777777777'),
    ).toEqual([]);
  });
});

describe('dismissApprovalNotifications', () => {
  it('그 승인의 알림만 걷고 걷은 수를 돌려준다', async () => {
    mockPresented.mockResolvedValue(center());

    const dismissed = await dismissApprovalNotifications(A1);

    expect(dismissed).toBe(2);
    expect(dismissedIds().sort()).toEqual(['a1-first', 'a1-second']);
  });

  it('다른 승인의 알림은 건드리지 않는다', async () => {
    mockPresented.mockResolvedValue(center());

    await dismissApprovalNotifications(A2);

    expect(dismissedIds()).toEqual(['a2-only']);
  });

  it('걸을 것이 없으면 아무것도 지우지 않는다', async () => {
    mockPresented.mockResolvedValue([delivered('plain-message', messagePayload())]);

    expect(await dismissApprovalNotifications(A1)).toBe(0);
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it('알림 센터를 읽지 못해도 던지지 않는다', async () => {
    mockPresented.mockRejectedValue(new Error('native module unavailable'));

    await expect(dismissApprovalNotifications(A1)).resolves.toBe(0);
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it('하나를 못 지워도 나머지는 지우고, 센 수는 지운 것만이다', async () => {
    mockPresented.mockResolvedValue(center());
    mockDismiss.mockImplementation(async identifier => {
      if (identifier === 'a1-first') throw new Error('gone');
    });

    await expect(dismissApprovalNotifications(A1)).resolves.toBe(1);
    expect(dismissedIds().sort()).toEqual(['a1-first', 'a1-second']);
  });
});

describe('settledApprovalIds · pendingApprovalIdSet', () => {
  it('전에는 대기였고 지금은 아닌 id만 돌려준다', () => {
    expect(
      settledApprovalIds(new Set([A1, A2]), new Set([A2])),
    ).toEqual([A1]);
    expect(settledApprovalIds(new Set([A2]), new Set([A1, A2]))).toEqual([]);
    expect(settledApprovalIds(new Set([A1]), new Set([A1]))).toEqual([]);
  });

  it('목록이 아니면 null이고, 비어 있는 목록은 빈 집합이다', () => {
    expect(pendingApprovalIdSet(undefined)).toBeNull();
    expect(pendingApprovalIdSet(null)).toBeNull();
    expect(pendingApprovalIdSet({approvals: []})).toBeNull();
    expect(pendingApprovalIdSet([])).toEqual(new Set());
  });

  it('소문자로 접고, 대기가 아닌 행은 세지 않는다', () => {
    const rows = [
      {id: A1.toUpperCase(), status: 'pending'},
      {id: A2, status: 'approved'},
    ] as unknown as Approval[];
    expect(pendingApprovalIdSet(rows)).toEqual(new Set([A1]));
  });
});

// ---- 관찰자 ---------------------------------------------------------------
// 실제 QueryClient의 캐시에 목록을 밀어 넣고(`setQueryData`는 재조회가 끝났을 때와 같은
// 성공 이벤트를 낸다) 걷히는 알림을 본다. 훅은 요청을 하지 않으므로 queryFn이 없다.

function row(id: string, status = 'pending'): Approval {
  return {id, status} as unknown as Approval;
}

function mountObserver(workspaceId = WS, preload?: Approval[]) {
  const client = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: Infinity}},
  });
  if (preload !== undefined) {
    client.setQueryData(pendingApprovalsKey(workspaceId), preload);
  }
  const wrapper = ({children}: {children: React.ReactNode}) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(
    ({workspace}: {workspace: string}) =>
      useDismissSettledApprovalNotifications(workspace),
    {wrapper, initialProps: {workspace: workspaceId}},
  );
  return {client, ...view};
}

/** 걷는 일이 비동기(알림 센터 읽기 → 지우기)라서 마이크로태스크를 비운다. */
async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

async function push(client: QueryClient, workspaceId: string, rows: Approval[]) {
  act(() => {
    client.setQueryData(pendingApprovalsKey(workspaceId), rows);
  });
  await settle();
}

describe('useDismissSettledApprovalNotifications: 다른 곳에서 결정된 승인', () => {
  beforeEach(() => {
    mockPresented.mockResolvedValue(center());
  });

  it('대기 목록에서 빠진 승인의 알림만 걷는다', async () => {
    const {client} = mountObserver(WS, [row(A1), row(A2)]);

    await push(client, WS, [row(A2)]);

    expect(dismissedIds().sort()).toEqual(['a1-first', 'a1-second']);
    expect(dismissedIds()).not.toContain('a2-only');
  });

  it('첫 로드는 기준선만 세운다: 아무것도 걷지 않는다', async () => {
    const {client} = mountObserver(WS);

    await push(client, WS, [row(A1), row(A2)]);

    expect(mockPresented).not.toHaveBeenCalled();
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it('같은 목록이거나 더 늘어난 목록은 걷지 않는다', async () => {
    const {client} = mountObserver(WS, [row(A1)]);

    await push(client, WS, [row(A1)]);
    await push(client, WS, [row(A1), row(A2)]);

    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it('여럿이 한꺼번에 빠지면 각각의 알림을 걷는다', async () => {
    const {client} = mountObserver(WS, [row(A1), row(A2)]);

    await push(client, WS, []);

    expect(dismissedIds().sort()).toEqual(['a1-first', 'a1-second', 'a2-only']);
  });

  it('원장의 대문자 id가 빠져도 소문자 봉투의 알림을 걷는다', async () => {
    const {client} = mountObserver(WS, [row(A1.toUpperCase())]);

    await push(client, WS, []);

    expect(dismissedIds().sort()).toEqual(['a1-first', 'a1-second']);
  });

  it('대소문자가 다르게 온 같은 승인은 빠진 것이 아니다', async () => {
    const {client} = mountObserver(WS, [row(A1.toUpperCase())]);

    await push(client, WS, [row(A1)]);

    expect(mockPresented).not.toHaveBeenCalled();
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it('대기가 아닌 행이 섞여 있어도 대기로 세지 않는다', async () => {
    // A2는 이미 승인된 행이다. 목록에 섞여 있었다고 그 알림이 걷힐 이유가 없다.
    const {client} = mountObserver(WS, [row(A1), row(A2, 'approved')]);

    await push(client, WS, []);

    expect(dismissedIds().sort()).toEqual(['a1-first', 'a1-second']);
  });

  it('재조회 실패는 결정이 아니다: 마지막으로 본 목록이 기준선으로 남는다', async () => {
    const {client} = mountObserver(WS, [row(A1), row(A2)]);

    await expect(
      client.fetchQuery({
        queryKey: pendingApprovalsKey(WS),
        queryFn: () => Promise.reject(new Error('offline')),
        retry: false,
        staleTime: 0,
      }),
    ).rejects.toThrow('offline');
    await settle();
    expect(mockDismiss).not.toHaveBeenCalled();

    await push(client, WS, [row(A2)]);
    expect(dismissedIds().sort()).toEqual(['a1-first', 'a1-second']);
  });

  it('목록이 아닌 값이 오면 기준선을 건드리지 않는다: 비었다고 읽지 않는다', async () => {
    const {client} = mountObserver(WS, [row(A1), row(A2)]);

    // 서버가 모양을 바꾼 응답. 「모른다」를 「비었다」로 접으면 대기 승인 전부의 알림이 걷힌다.
    await push(client, WS, {approvals: []} as unknown as Approval[]);
    expect(mockDismiss).not.toHaveBeenCalled();

    await push(client, WS, [row(A2)]);
    expect(dismissedIds().sort()).toEqual(['a1-first', 'a1-second']);
  });

  it('다른 워크스페이스의 대기 목록은 보지 않는다', async () => {
    const {client} = mountObserver(WS, [row(A1)]);
    client.setQueryData(pendingApprovalsKey(OTHER_WS), [row(A1)]);

    await push(client, OTHER_WS, []);

    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it('대기 목록이 아닌 승인 쿼리는 보지 않는다', async () => {
    const {client} = mountObserver(WS, [row(A1)]);

    act(() => {
      client.setQueryData(['approvals', WS, 'approved'], []);
    });
    await settle();

    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it('워크스페이스가 바뀌면 기준선을 새로 세운다', async () => {
    const {client, rerender} = mountObserver(WS, [row(A1)]);

    rerender({workspace: OTHER_WS});
    // 새 워크스페이스의 첫 로드: 이전 워크스페이스의 기준선과 비교하지 않는다.
    await push(client, OTHER_WS, [row(A2)]);
    expect(mockDismiss).not.toHaveBeenCalled();

    // 이전 워크스페이스는 더 이상 듣지 않는다.
    await push(client, WS, []);
    expect(mockDismiss).not.toHaveBeenCalled();

    // 새 워크스페이스 안에서의 변화는 듣는다.
    await push(client, OTHER_WS, []);
    expect(dismissedIds()).toEqual(['a2-only']);
  });

  it('언마운트하면 더 듣지 않는다', async () => {
    const {client, unmount} = mountObserver(WS, [row(A1)]);

    unmount();
    await push(client, WS, []);

    expect(mockDismiss).not.toHaveBeenCalled();
  });
});
