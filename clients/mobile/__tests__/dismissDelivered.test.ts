import * as Notifications from 'expo-notifications';

import {dismissDeliveredNotifications} from '../src/push/dismissDelivered';

// =============================================================================
// #3931 — 로그아웃이 알림 센터를 비운다. 이 파일은 그 호출 자체를 잰다(`signOut()` 가 부르는지는
// `pushActionCredential.test.tsx` 가 진짜 프로바이더 위에서 잰다): 알림 센터를 비우고, 못 비워도 던지지
// 않는다. 던지면 `void` 로 부르는 로그아웃 쪽에서는 처리되지 않은 거절이 되어 아무 시험도 모르게 지나간다.
// =============================================================================

const dismissAll = Notifications.dismissAllNotificationsAsync as jest.Mock;

beforeEach(() => {
  dismissAll.mockReset();
  dismissAll.mockResolvedValue(undefined);
});

describe('알림 센터 비우기', () => {
  it('배달된 알림을 모두 지운다', async () => {
    await dismissDeliveredNotifications();

    expect(dismissAll).toHaveBeenCalledTimes(1);
  });

  it('못 비워도 던지지 않는다 — 로그아웃은 알림 센터가 막지 못한다', async () => {
    dismissAll.mockRejectedValueOnce(new Error('notifications are off'));

    await expect(dismissDeliveredNotifications()).resolves.toBeUndefined();
  });

  it('호출이 동기로 던져도 던지지 않는다', async () => {
    dismissAll.mockImplementationOnce(() => {
      throw new Error('native module missing');
    });

    await expect(dismissDeliveredNotifications()).resolves.toBeUndefined();
  });
});
