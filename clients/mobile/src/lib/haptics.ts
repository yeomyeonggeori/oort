import {useSyncExternalStore} from 'react';
import {AppState, Platform} from 'react-native';

import {NON_SECRET_KEYS, nonSecretStore} from '../storage/kv';

// User events only. Never queue a suppressed pulse; visuals must stand on their own.
export type HapticMode = 'rich' | 'basic' | 'off';
export const HAPTIC_MODES = [
  { value: 'rich', label: '풍부' },
  { value: 'basic', label: '기본' },
  { value: 'off', label: '끔' },
] as const;

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
  reactionCandidateChanged: ['selection', 'basic'],
  profileOpened: ['light', 'basic'],
  jumpToLatest: ['light', 'rich'],
  tabChanged: ['selection', 'rich'],
  filterChanged: ['selection', 'rich'],
  deleteConfirmed: ['medium', 'rich'],
  recordingStarted: ['light', 'basic'],
  recordingStopped: ['medium', 'basic'],
  refreshThreshold: ['light', 'basic'],
  refreshFailed: ['warning', 'basic'],
} as const satisfies Record<string, readonly [Pattern, 'rich' | 'basic']>;
export type HapticEvent = keyof typeof events;

const listeners = new Set<() => void>();
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function getHapticMode(): HapticMode {
  const stored = nonSecretStore().getString(NON_SECRET_KEYS.hapticMode);
  return stored === 'basic' || stored === 'off' ? stored : 'rich';
}
export function setHapticMode(mode: HapticMode): void {
  if (getHapticMode() === mode) return;
  nonSecretStore().set(NON_SECRET_KEYS.hapticMode, mode);
  listeners.forEach(listener => listener());
}
export function useHapticMode(): HapticMode {
  return useSyncExternalStore(subscribe, getHapticMode, getHapticMode);
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
  if (now - lastAt < 100) return;
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

// Keep these names: other S1 slots own their call sites. Rich-only legacy light/selection
// cover send, custom sheet, tab/filter; semantic base events use event() explicitly.
export const haptics = {
  event(event: HapticEvent): void {
    const [pattern, level] = events[event];
    fire(pattern, level);
  },
  selection(): void {
    fire('selection', 'rich');
  },
  light(): void {
    fire('light', 'rich');
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
