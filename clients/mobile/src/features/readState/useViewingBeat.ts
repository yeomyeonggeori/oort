import {useEffect} from 'react';
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
