import {AppState, Platform} from 'react-native';

import {NON_SECRET_KEYS, nonSecretStore} from '../storage/kv';

// User events only. Never queue a suppressed pulse; visuals must stand on their own.
// 동작 줄이기는 햅틱 설정과 별개이며(research-1029/haptics/report.md:55), 시스템 진동 끔은 iOS 피드백 생성기가 지킨다.
//
// 앱 햅틱은 늘 「풍부」다(owner 10-31, #4936). 설정에 고르는 곳이 없고 앱 코드는 단계를 바꾸지 않는다 — 예전 판이 저장한
// 「기본」·「끔」(`momo.mobile.haptics.v1`)도 읽지 않는다(`NON_SECRET_KEYS.hapticMode` 를 v2로 올렸다).
// 아래 `basic`·`off` 는 **내부 이음새**다: 사건마다의 단계(기본/풍부)와 풍부 모드의 100ms 창을 시험이 따로 재려고 남겼고
// (예: 밀어서 답글은 창이 없는 기본 모드에서 컨테이너의 중복 방어를 잰다), `setHapticMode` 는 시험만 부른다.
// `__tests__/hapticsAlwaysRich.test.ts` 가 앱 소스가 `setHapticMode` 를 부르는 것을 막는다.
export type HapticMode = 'rich' | 'basic' | 'off';

type Pattern =
  | 'selection'
  | 'light'
  | 'medium'
  | 'success'
  | 'warning'
  | 'error';
const events = {
  messageMenu: ['medium', 'basic'],
  reactionChanged: ['selection', 'basic'],
  actionFailed: ['error', 'basic'],
  reactionCandidateChanged: ['selection', 'basic'],
  profileOpened: ['light', 'basic'],
  jumpToLatest: ['light', 'rich'],
  tabChanged: ['selection', 'rich'],
  filterChanged: ['selection', 'rich'],
  deleteConfirmed: ['medium', 'rich'],
  recordingStarted: ['light', 'basic'],
  recordingStopped: ['medium', 'basic'],
  refreshThreshold: ['light', 'basic'],
  refreshSucceeded: ['success', 'basic'],
  refreshFailed: ['warning', 'basic'],
  // 밀어서 답글(#4869): 실행 문턱을 **처음** 지나는 순간 한 번(제스처당 1회는 부르는 쪽이 지킨다). 기본·풍부 모두 `light`
  // (research-1029/haptics/report.md §5 「답글 스와이프」) — 스크롤·이동 중에는 울리지 않는다.
  replySwipeThreshold: ['light', 'basic'],
} as const satisfies Record<string, readonly [Pattern, 'rich' | 'basic']>;
export type HapticEvent = keyof typeof events;

/** 저장된 값이 없으면 풍부다. 앱 코드는 이 키에 쓰지 않는다 — 시험 이음새(`setHapticMode`)가 쓸 뿐이다. */
export function getHapticMode(): HapticMode {
  const stored = nonSecretStore().getString(NON_SECRET_KEYS.hapticMode);
  return stored === 'basic' || stored === 'off' ? stored : 'rich';
}
/** 시험 이음새. 앱에는 단계를 고르는 화면이 없고, 앱 코드는 이것을 부르지 않는다. */
export function setHapticMode(mode: HapticMode): void {
  if (getHapticMode() === mode) return;
  nonSecretStore().set(NON_SECRET_KEYS.hapticMode, mode);
}

let appEpoch = 0;
AppState.addEventListener('change', state => {
  if (state !== 'active') appEpoch += 1;
});
/** Capture at the user action. Leaving the app/screen cancels late results, even after returning. */
export function hapticScope(
  isCurrent: () => boolean,
): (event: HapticEvent) => void {
  const epoch = appEpoch;
  return event => {
    if (epoch === appEpoch && isCurrent()) haptics.event(event);
  };
}

type HapticsModule = typeof import('expo-haptics');
let cached: HapticsModule | null | undefined;
let lastAt = -Infinity;
function load(): HapticsModule | null {
  if (cached !== undefined) return cached;
  try {
    cached = require('expo-haptics') as HapticsModule;
  } catch {
    cached = null;
  }
  return cached;
}
function fire(pattern: Pattern, level: 'basic' | 'rich' = 'basic'): void {
  if (AppState.currentState !== 'active') return;
  const mode = getHapticMode();
  if (mode === 'off' || (mode === 'basic' && level === 'rich')) return;
  const now = performance.now(); // monotonic, shared across ALL callers, including legacy APIs
  // Basic keeps one request per existing action, including separate rapid taps.
  // The rich mode's extra events share a window; it must not swallow basic actions.
  if (mode === 'rich' && now - lastAt < 100) return;
  const native = load();
  if (!native) return;
  lastAt = now;
  try {
    let result: Promise<void>;
    if (Platform.OS === 'android') {
      // Android's semantic path respects system touch-feedback settings; no Vibrator fallback.
      const kind = {
        selection: native.AndroidHaptics.Segment_Tick,
        light: native.AndroidHaptics.Context_Click,
        medium: native.AndroidHaptics.Long_Press,
        success: native.AndroidHaptics.Confirm,
        warning: native.AndroidHaptics.Reject,
        error: native.AndroidHaptics.Reject,
      }[pattern];
      result = native.performAndroidHapticsAsync(kind);
    } else if (pattern === 'selection') result = native.selectionAsync();
    else if (pattern === 'light' || pattern === 'medium') {
      result = native.impactAsync(
        pattern === 'light'
          ? native.ImpactFeedbackStyle.Light
          : native.ImpactFeedbackStyle.Medium,
      );
    } else {
      const kind = {
        success: native.NotificationFeedbackType.Success,
        warning: native.NotificationFeedbackType.Warning,
        error: native.NotificationFeedbackType.Error,
      }[pattern];
      result = native.notificationAsync(kind);
    }
    void result.catch(() => undefined);
  } catch {
    /* Missing engine/module must never break an action. */
  }
}

// Existing screens keep their patterns/counts in basic mode. New optional feedback
// uses rich-level semantic events rather than changing these compatibility APIs.
export const haptics = {
  event(event: HapticEvent): void {
    // Rich uses the threshold pulse; basic preserves the existing success feedback.
    if (event === 'refreshSucceeded' && getHapticMode() === 'rich') return;
    const [pattern, level] = events[event];
    fire(pattern, level);
  },
  selection(): void {
    fire('selection');
  },
  light(): void {
    fire('light');
  },
  medium(): void {
    fire('medium');
  },
  success(): void {
    fire('success');
  },
  warning(): void {
    fire('warning');
  },
  error(): void {
    fire('error');
  },
};

/** Test clocks restart between cases; production never resets its monotonic window. */
export function __resetHapticClockForTests(): void {
  lastAt = -Infinity;
}
