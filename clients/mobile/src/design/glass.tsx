import React, {useEffect, useState} from 'react';
import {
  AccessibilityInfo,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import {useStyles, useTheme} from './theme';
import type {Palette} from './tokens';

// =============================================================================
// 유리 재료 — 떠 있는 탭바가 서는 면 (ADR-0189 D1·D7, DS2-2 #2714).
//
// 시안 A의 탭바는 `background: var(--glass); backdrop-filter: blur(22px)
// saturate(1.4)`다. 폰에서는 `expo-blur`(MIT, ADR-0189 D6가 들인 유일한 새 의존)
// 의 `BlurView`가 뒤를 흐리고, 그 위에 core `glass` 틴트를 한 겹 얹는다. 세 갈래다:
//
//   1. 투명도 줄이기가 켜져 있다 → 불투명 `surface`. 흐림도 틴트도 없다. 설정을
//      켠 사람에게 반투명은 **읽기 어려운 것**이지 장식이 아니다(D7).
//   2. 블러 네이티브 모듈이 없다(저사양·구성 실패) → `surface` 94%(`glassFallback`).
//      94%에서도 글자 대비가 유지되는 것은 core가 쟀다(themes-2.0 §유리).
//   3. 그 밖 → `BlurView` + `glass` 틴트.
//
// 「저사양」을 기기 등급으로 추측하지 않는다. 모델 이름표로 느린 기기를 고르는
// 규칙은 틀리는 날이 반드시 오고, 틀리면 빠른 기기가 불투명을 입거나 느린 기기가
// 흐림을 돌린다. 판단할 수 있는 사실은 **블러를 그릴 모듈이 이 빌드에 있는가**
// 하나이고, 그 사실로만 가른다.
// =============================================================================

/** 이 빌드에 블러를 그릴 네이티브 모듈이 있는가. 한 번 묻고 기억한다. */
let blurAnswer: boolean | null = null;

export function blurSupported(): boolean {
  if (blurAnswer !== null) return blurAnswer;
  try {
    // `expo-modules-core`가 모듈을 못 찾으면 `null`을 돌려준다(던지지 않는다).
    // jest처럼 네이티브가 없는 곳에서는 여기서 `false`가 나와 대체 경로를 탄다.
    const core = require('expo-modules-core') as {
      requireOptionalNativeModule?: (name: string) => unknown;
    };
    blurAnswer = core.requireOptionalNativeModule?.('ExpoBlur') != null;
  } catch {
    blurAnswer = false;
  }
  return blurAnswer;
}

/** 시험 전용: 기억한 답을 지운다. */
export function resetBlurSupportForTests(value: boolean | null = null): void {
  blurAnswer = value;
}

/**
 * iOS 「투명도 줄이기」. 켜고 끄면 바로 다시 그려야 하므로 ref 가 아니라 상태다
 * (`useReduceMotionRef`와 다른 이유: 저것은 누르는 순간에만 읽지만 이것은 화면의
 * 재료다). 첫 답이 오기 전에는 `false`다 — 한 틱 동안 유리였다가 불투명이 되는
 * 편이, 모르는 동안 모두에게 불투명을 입히는 것보다 덜 틀린다.
 */
export function useReduceTransparency(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceTransparencyEnabled().then(
      value => {
        if (alive) setReduce(value);
      },
      () => {
        /* 모름은 false 로 남는다 */
      },
    );
    const subscription = AccessibilityInfo.addEventListener(
      'reduceTransparencyChanged',
      value => setReduce(value),
    );
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);
  return reduce;
}

export type GlassMaterial = 'opaque' | 'fallback' | 'blur';

/** 세 갈래 중 어느 재료로 그릴지 (파일 머리 주석). */
export function glassMaterial(reduceTransparency: boolean, supported: boolean): GlassMaterial {
  if (reduceTransparency) return 'opaque';
  return supported ? 'blur' : 'fallback';
}

/** BlurView 세기(1~100). CSS `blur(22px)`와 1:1 대응이 없다 — PR 「시안과의 차이」. */
export const GLASS_BLUR_INTENSITY = 60;

/**
 * 유리 면. 자식은 유리 **위**에 선다. 모양(반경·크기)은 `style`이 정한다.
 *
 * 재료는 `testID` 뒤에 `-opaque`·`-fallback`·`-blur`를 붙인 자식으로 드러나서,
 * 시험이 어느 갈래를 탔는지 렌더 트리에서 읽는다.
 */
export function GlassSurface({
  radius,
  style,
  children,
  testID,
}: {
  /** 흐림과 틴트를 자르는 반경. 모양의 반경과 같은 값을 준다. */
  radius: number;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {scheme} = useTheme();
  const reduce = useReduceTransparency();
  const material = glassMaterial(reduce, blurSupported());

  let layer: React.ReactNode;
  if (material === 'blur') {
    // 모듈이 있을 때만 불러온다. 없는 빌드에서 import 가 평가되면 네이티브 뷰
    // 매니저를 찾다가 경고를 남긴다.
    const {BlurView} = require('expo-blur') as typeof import('expo-blur');
    layer = (
      <>
        <BlurView
          intensity={GLASS_BLUR_INTENSITY}
          tint={scheme === 'light' ? 'light' : 'dark'}
          style={StyleSheet.absoluteFill}
        />
        <View style={[StyleSheet.absoluteFill, styles.tint]} testID={testID && `${testID}-blur`} />
      </>
    );
  } else {
    layer = (
      <View
        style={[
          StyleSheet.absoluteFill,
          material === 'opaque' ? styles.opaque : styles.fallback,
        ]}
        testID={testID && `${testID}-${material}`}
      />
    );
  }

  return (
    <View style={[styles.frame, style]} testID={testID}>
      <View style={[styles.clip, {borderRadius: radius}]} pointerEvents="none">
        {layer}
      </View>
      {children}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    frame: {overflow: 'visible'},
    // 흐림과 틴트는 모양 안에서 잘린다. 그림자는 바깥 `frame`이 그린다.
    clip: {position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, overflow: 'hidden'},
    tint: {backgroundColor: color.glass},
    fallback: {backgroundColor: color.glassFallback},
    opaque: {backgroundColor: color.surface},
  });
