import {
  requireNativeViewManager,
  requireOptionalNativeModule,
} from 'expo-modules-core';
import type React from 'react';
import type {StyleProp, ViewStyle} from 'react-native';

// =============================================================================
// The JS face of `modules/momo-keyboard-native` (goal RN-P3).
//
// Thin on purpose: everything this file could do in JavaScript is a thing the
// module exists to stop doing in JavaScript. There is no `useKeyboard()` here,
// no listener, no `Animated.Value` — the pane is told how much safe-area inset
// it already pays, and from then on it answers to UIKit directly.
//
// `src/lib/useKeyboard.ts` still exists and is still right for what remains of
// it: `MessageEditorSheet` needs the keyboard's HEIGHT as a number to lay itself
// out, which is a question about where things ended up rather than about the
// journey, and a render later is not a defect there.
// =============================================================================

export interface KeyboardPaneProps {
  /**
   * The bottom safe-area inset, in points, that this pane pays as padding.
   *
   * The native side lifts by `keyboardHeight - bottomInset`, clamped at zero: a
   * raised keyboard already covers the home indicator, and paying both leaves a
   * dead band between the input and the keys.
   */
  bottomInset: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  children?: React.ReactNode;
}

/**
 * The pane. A native view, and the reason is timing rather than taste — see the
 * header of `modules/momo-keyboard-native/ios/MomoKeyboardPaneView.swift`.
 *
 * **Do not give this a `transform` style.** The native side owns
 * `layer.transform`, and it is safe from React Native only for as long as the
 * `transform` prop stays empty (`RCTViewComponentView.mm:350-360` writes the
 * layer only when that prop changes).
 */
export const KeyboardPane =
  requireNativeViewManager<KeyboardPaneProps>('MomoKeyboardNative');

/** What the native instrument recorded for the last raise or lower. */
export interface KeyboardTravelRecord {
  /** 0 when nothing has been recorded yet; every other field is meaningless then. */
  available: number;
  /** ms from the keyboard notification to the first MOVED frame on screen. */
  igniteMs: number;
  /** ms to the first frame on which Core Animation was RUNNING the travel. */
  armedMs: number;
  /** ms to the animation being committed — the ignition latency, unquantised. */
  commitMs: number;
  /** ms to the first frame at the destination. */
  arriveMs: number;
  frames: number;
  /** Frames strictly between the ends: zero means it snapped rather than glided. */
  midFlight: number;
  fromPx: number;
  toPx: number;
  durationMs: number;
  curve: number;
  /** 1 when the frame came from `simulateKeyboard` rather than from iOS. */
  simulated: number;
  /** Where the pane is resting now, in points. Negative is up. */
  liftPx: number;
}

interface KeyboardNativeModule {
  lastTravel: () => Partial<KeyboardTravelRecord>;
  simulateKeyboard: (height: number, durationMs: number) => void;
}

/**
 * Optional, because these two are measurement seams and nothing in the app calls
 * them. `requireOptionalNativeModule` answers `null` in a build without the
 * module — and under Jest, where there is no native side at all.
 */
export const keyboardNative =
  requireOptionalNativeModule<KeyboardNativeModule>('MomoKeyboardNative');
