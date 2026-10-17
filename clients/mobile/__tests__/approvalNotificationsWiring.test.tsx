import type {Approval, Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, render} from '@testing-library/react-native';
import * as Notifications from 'expo-notifications';
import React from 'react';
import {Text} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {pendingApprovalsKey} from '../src/features/conversation/usePendingApprovals';
import PushProvider from '../src/push/PushProvider';
import {SessionProvider} from '../src/session/useSession';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// 결정된 승인의 알림 걷기가 `PushProvider`에 달려 있다 (#3926).
//
// `approvalNotifications.test.tsx`는 관찰자 훅(`useDismissSettledApprovalNotifications`)을
// 하네스에서 **직접** 마운트해 잰다. 그래서 그 훅이 실제로 앱에 꽂혀 있는지 — `PushProvider`
// 의 리스너 절 끝 한 줄 — 는 그 파일이 못 잰다. 그 줄을 지워도 훅의 시험은 전부 통과하고
// (사보타주로 확인했다), 앱에서는 다른 기기의 결정이 잠금 화면의 승인 버튼을 죽은 채로
// 남긴다. 이 파일이 그 한 줄을 잰다: 진짜 세션·진짜 `PushProvider` 아래에서 세션
// 워크스페이스의 대기 목록에서 빠진 승인의 알림이 걷히는지. 그 줄을 지우거나 훅에 다른
// 워크스페이스 id를 넘기면 이 파일이 빨갛다.
//
// 훅의 동작(첫 로드는 기준선, 대소문자, 워크스페이스 전환 등)은 위 파일의 몫이라 여기서
// 되풀이하지 않는다. 권한은 거부로 둔다 — 이 파일이 재는 것은 푸시 등록이 아니다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const MEMBER: Member = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: WS,
  kind: 'human',
  displayName: 'Seongjae Kwak',
  handle: 'seongjae',
};
const CHANNEL = '33333333-3333-4333-8333-333333333333';
const MESSAGE = '44444444-4444-4444-8444-444444444444';
// 16진 문자가 든 id: 숫자뿐이면 대소문자 비교를 깨뜨려도 통과한다
// (`approvalNotifications.test.tsx` 머리의 같은 주석).
const A1 = '5555abcd-5555-4555-8555-55555555ef01';
const A2 = '6666abcd-6666-4666-8666-66666666ef02';

const getPermissions = Notifications.getPermissionsAsync as jest.Mock;
const mockPresented = jest.mocked(Notifications.getPresentedNotificationsAsync);
const mockDismiss = jest.mocked(Notifications.dismissNotificationAsync);

/** 알림 센터에 배달된 승인 푸시 하나. 모양은 `getPresentedNotificationsAsync`가 돌려주는 것. */
function deliveredApproval(identifier: string, approvalId: string) {
  return {
    date: 0,
    request: {
      identifier,
      content: {},
      trigger: {
        type: 'push',
        payload: {
          aps: {badge: 1, 'thread-id': CHANNEL, category: 'momo.approval'},
          momo: {
            schema: 'momo.push.notification.v2',
            server_id: 'srv-1',
            workspace_id: WS,
            channel_id: CHANNEL,
            message_id: MESSAGE,
            collapse_id: `collapse-${identifier}`,
            reason: 'approval_request',
            approval_id: approvalId,
          },
        },
      },
    },
  } as unknown as Notifications.Notification;
}

function row(id: string): Approval {
  return {id, status: 'pending'} as unknown as Approval;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase('https://api.example.com');
  sessionPort.applyLogin({
    accessToken: 'access-token-1',
    refreshToken: 'refresh-token-1',
    realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
    member: MEMBER,
  });
  globalThis.fetch = jest.fn(async () =>
    jsonResponse(200, {items: [], unreadTotal: 0}),
  ) as unknown as typeof fetch;
  getPermissions.mockReset().mockResolvedValue({
    status: 'denied',
    granted: false,
    canAskAgain: false,
    expires: 'never',
    ios: {status: 1},
  });
  mockPresented.mockReset().mockResolvedValue([
    deliveredApproval('a1-push', A1),
    deliveredApproval('a2-push', A2),
  ]);
  mockDismiss.mockReset().mockResolvedValue(undefined);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** 알림 센터 읽기 → 지우기가 비동기라서 마이크로태스크를 비운다. */
async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

function mount(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider member={MEMBER}>
        <PushProvider>
          <Text>signed in</Text>
        </PushProvider>
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe('PushProvider: 다른 곳에서 결정된 승인의 알림 걷기 (#3926)', () => {
  it('세션 워크스페이스의 대기 목록에서 빠진 승인의 알림만 걷는다', async () => {
    const client = new QueryClient({
      defaultOptions: {queries: {retry: false, gcTime: Infinity}},
    });
    client.setQueryData(pendingApprovalsKey(WS), [row(A1), row(A2)]);
    mount(client);
    await settle();
    // 마운트만으로는 걷지 않는다: 첫 목록은 기준선이다.
    expect(mockDismiss).not.toHaveBeenCalled();

    // 다른 기기가 A1을 결정했고, 에이전트 프레임이 원장을 다시 읽게 해 목록에서 빠졌다.
    act(() => {
      client.setQueryData(pendingApprovalsKey(WS), [row(A2)]);
    });
    await settle();

    expect(mockDismiss.mock.calls.map(([identifier]) => identifier)).toEqual([
      'a1-push',
    ]);
  });
});
