// =============================================================================
// 햅틱 — 사용자가 만든 순간에 한 번, 시각과 같은 프레임에 (#3580).
//
// emil `animate-expo` §8 의 세 규칙이 이 파일의 계약이다:
//   1. 시각과 **같은 프레임** — 호출은 누름 핸들러 안에서 동기로 한다(await·타이머 없음).
//   2. **사용자 행동 1회 = 호출 1회** — 스크롤·프레임·실시간 수신·애니메이션 끝에서는 부르지 않는다.
//   3. **유일한 피드백이 아니다** — 시스템 햅틱 설정이 꺼져 있으면 OS 가 아무것도 내지 않는다
//      (앱이 그 설정을 따로 읽을 필요가 없다). 시각이 단독으로도 서야 한다.
//
// 모듈은 지연 로드한다: 네이티브 모듈이 없는 빌드(구 빌드·Jest)에서 import 가 던지면
// 탭 한 번이 앱을 죽인다. 실패는 삼킨다 — 햅틱이 기능을 깨뜨리면 안 된다.
// =============================================================================

type HapticsModule = typeof import('expo-haptics');

let cached: HapticsModule | null | undefined;

function load(): HapticsModule | null {
  if (cached !== undefined) return cached;
  try {
    cached = require('expo-haptics') as HapticsModule;
  } catch {
    cached = null;
  }
  return cached;
}

function fire(run: (haptics: HapticsModule) => Promise<void>): void {
  const haptics = load();
  if (haptics === null) return;
  try {
    run(haptics).catch(() => {
      /* 햅틱이 없는 기기·설정 끔 — 조용히 */
    });
  } catch {
    /* 동기 예외도 같다 */
  }
}

export const haptics = {
  /** 값이 한 칸 넘어갈 때 — 탭 전환·필터·섹션 접기. */
  selection(): void {
    fire(h => h.selectionAsync());
  },
  /** 무언가 열리거나 자리 잡을 때 — 프로필·+ 메뉴. */
  light(): void {
    fire(h => h.impactAsync(h.ImpactFeedbackStyle.Light));
  },
  /** 무거운 것이 내려앉거나 파괴적 행동이 나갈 때(S2). */
  medium(): void {
    fire(h => h.impactAsync(h.ImpactFeedbackStyle.Medium));
  },
  /** 작업이 끝났다(S2: 전송 확정). */
  success(): void {
    fire(h => h.notificationAsync(h.NotificationFeedbackType.Success));
  },
  /** 되돌릴 수 없는 일을 확인하고 나갈 때 - 멈추기(N4 #3596). 탭 한 번에 한 번. */
  warning(): void {
    fire(h => h.notificationAsync(h.NotificationFeedbackType.Warning));
  },
  /** 작업이 실패했다(S2: 전송 실패). */
  error(): void {
    fire(h => h.notificationAsync(h.NotificationFeedbackType.Error));
  },
};
