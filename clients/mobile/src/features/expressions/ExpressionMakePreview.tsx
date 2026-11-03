import type {MotionChoice} from '@momo/core/features/expressions/make';
import React, {useEffect, useRef} from 'react';
import {
  Animated,
  Easing,
  Image,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import {useStyles} from '../../design/theme';
import {ds2Radius, font, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {
  MAKE_PREVIEW_KEYFRAMES,
  SPARKLE_STARS,
  anchoredBounceTranslate,
  previewTiming,
  sampledTrack,
  starTrack,
  type PreviewTrack,
} from './makePreviewModel';

// =============================================================================
// 「AI와 만들기」 칩의 미리보기 (#4891, ADR-0218 §7 G3.3).
//
// 이 그림은 G3.3 표의 움직임을 **비슷하게 흉내 낸 것**이다. 정확한 결과(프레임·눌림·별의 모양과 자리)는 서버 조립이 만들고,
// 사람은 그 결과를 승인 카드에서 따로 본다. 길이와 반복(총 4회 재생 뒤 멈춤)·키프레임 값만 웹과 같고(`makePreviewModel`),
// 시험이 CSS 와 대조한다.
//
//   · 동작 줄이기면 아무것도 움직이지 않고 정지 그림만 보인다(애니메이션을 만들지도 않는다).
//   · 누르면 다시 재생한다: `playKey` 가 바뀌면 처음부터 돈다. 끝나면 처음 모습으로 멈춘다(끝 상태를 붙잡지 않는다).
//   · 장식이라 보조기술에는 숨긴다 — 칩의 이름과 설명이 뜻을 전한다.
// =============================================================================

const BOX = TOUCH_TARGET + space.xs;
/** G3.2: 그림은 정사각 캔버스 한 변의 80% 안에 가운데로 맞추고 사방 10% 여백을 남긴다. */
const PICTURE = BOX * 0.8;

function drive(
  progress: Animated.Value,
  track: PreviewTrack,
  output: (value: number) => number | string,
) {
  return progress.interpolate({
    inputRange: [...track.at],
    outputRange: track.values.map(output) as number[] | string[],
  });
}

export function ExpressionMakePreview({
  motion,
  uri,
  playKey,
  reduce,
  testID,
}: {
  motion: MotionChoice;
  uri: string | null;
  /** 바뀌면 처음부터 다시 재생한다. */
  playKey: string;
  reduce: boolean;
  testID: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const progress = useRef(new Animated.Value(0)).current;
  const animated = !reduce && uri !== null && motion !== 'still';
  useEffect(() => {
    progress.setValue(0);
    if (!animated) return;
    const {durationMs, iterations} = previewTiming(motion);
    const run = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: durationMs,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
      {iterations},
    );
    // 끝나면 처음 모습으로 멈춘다.
    run.start(({finished}) => {
      if (finished) progress.setValue(0);
    });
    return () => run.stop();
  }, [animated, motion, playKey, uri, progress]);

  const transform: Record<string, Animated.AnimatedInterpolation<number | string>>[] = [];
  if (animated && motion === 'bounce') {
    const {curve, scaleX, scaleY} = MAKE_PREVIEW_KEYFRAMES.bounce;
    transform.push(
      {
        translateY: drive(
          progress,
          sampledTrack(anchoredBounceTranslate(), curve),
          value => value * PICTURE,
        ),
      },
      {scaleX: drive(progress, sampledTrack(scaleX, curve), value => value)},
      {scaleY: drive(progress, sampledTrack(scaleY, curve), value => value)},
    );
  } else if (animated && motion === 'wobble') {
    const {curve, rotateDeg} = MAKE_PREVIEW_KEYFRAMES.wobble;
    transform.push({
      rotate: drive(progress, sampledTrack(rotateDeg, curve), value => `${value}deg`),
    });
  } else if (animated && motion === 'pulse') {
    const {curve, scale} = MAKE_PREVIEW_KEYFRAMES.pulse;
    transform.push({
      scale: drive(progress, sampledTrack(scale, curve), value => value),
    });
  }
  return (
    <View
      style={styles.box}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID={testID}>
      {/* 보간값(`AnimatedInterpolation`)은 `ViewStyle` 의 변환 타입에 들어가지 않는다 — 네이티브 구동 변환의 알려진 타입 한계다. */}
      <Animated.View style={[styles.picture, {transform} as unknown as ViewStyle]}>
        {uri !== null ? (
          <Image source={{uri}} resizeMode="contain" style={styles.image} />
        ) : null}
      </Animated.View>
      {animated && motion === 'sparkle'
        ? SPARKLE_STARS.map(star => (
            <Animated.View
              key={star}
              style={[
                styles.star,
                STAR_CORNER[star],
                {opacity: drive(progress, starTrack(star), value => value)},
              ]}>
              <Text style={styles.starGlyph}>✦</Text>
            </Animated.View>
          ))
        : null}
    </View>
  );
}

const STAR_INSET = space.xs / 2;
const STAR_CORNER = [
  {top: STAR_INSET, left: STAR_INSET},
  {top: STAR_INSET, right: STAR_INSET},
  {bottom: STAR_INSET, right: STAR_INSET},
  {bottom: STAR_INSET, left: STAR_INSET},
] as const;

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    box: {
      width: BOX,
      height: BOX,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
      borderRadius: ds2Radius.badge,
      backgroundColor: color.surfaceMuted,
    },
    picture: {width: PICTURE, height: PICTURE},
    image: {width: '100%', height: '100%'},
    star: {position: 'absolute'},
    starGlyph: {fontSize: font.caption, color: color.textMuted},
  });
