import {useEffect, useState} from 'react';
import {AppState, type AppStateStatus} from 'react-native';
import {
  holdChannelViewing,
  type ForegroundPort,
} from '@momo/core/features/readState/viewingBeat';

// 「보고 있음」 존재 신호의 폰 어댑터 (ADR-0204 증보 3, #4063).
// 앞에 있다 = AppState 'active' 하나뿐이다. 'inactive'(알림 센터·전화·앱 전환기)도
// 멈춘다: 그 순간 사용자는 이 채널을 보고 있지 않고, 잘못 멈춘 쪽의 대가는 푸시
// 한 번 일찍 오는 것이다(배터리와 거짓 「보고 있음」 중 후자가 더 나쁘다).
export const appStateForeground: ForegroundPort = {
  isForeground: () => AppState.currentState === 'active',
  subscribe: onChange => {
    const subscription = AppState.addEventListener(
      'change',
      (next: AppStateStatus) => onChange(next === 'active'),
    );
    return () => subscription.remove();
  },
};

/**
 * 앱이 앞에 있는가 — 「보고 있음」 신호와 같은 어댑터(`appStateForeground`)를 구독한다. 뒤에 있는 동안 온 답글을 읽은 것으로
 * 치지 않는 판정이 이 하나다: 스레드 화면의 읽음 신호(`ThreadPanel`)와 열린 스레드의 요약 줄(`ConversationScreen` →
 * `Timeline.viewingThreadId`)이 같은 값을 읽어야 서로 어긋나지 않는다(#5032).
 *
 * `enabled`가 거짓이면 구독도 재그림도 없다(늘 앞이라고 답한다): 대화 화면은 열린 스레드가 없을 때 앱 앞뒤 전환에 다시 그려질 이유가 없다.
 */
export function useAppForeground(enabled = true): boolean {
  const [active, setActive] = useState(() => appStateForeground.isForeground());
  useEffect(() => {
    if (!enabled) return undefined;
    // 구독을 걸지 않은 동안의 전이는 못 봤으니 거는 순간의 값으로 맞춘다.
    setActive(appStateForeground.isForeground());
    const unsubscribe = appStateForeground.subscribe(setActive);
    return () => {
      unsubscribe();
      // 구독이 끝나면 값도 버린다: 다음에 켤 때 낡은 값이 먼저 읽히지 않게 한다. 꺼 둔 동안은 늘 앞이라고 답한다.
      setActive(true);
    };
  }, [enabled]);
  return enabled ? active : true;
}

/** 대화 화면이 앞에 있는 동안만 신호를 보낸다. */
export function useViewingBeat(
  workspaceId: string,
  channelId: string,
  foreground: ForegroundPort = appStateForeground,
): void {
  useEffect(() => {
    if (workspaceId === '' || channelId === '') {
      return undefined;
    }
    return holdChannelViewing(workspaceId, channelId, foreground);
  }, [workspaceId, channelId, foreground]);
}
