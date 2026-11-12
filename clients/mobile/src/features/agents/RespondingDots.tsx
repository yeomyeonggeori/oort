import React, {useEffect, useRef} from 'react';
import {Animated, Easing, StyleSheet, View} from 'react-native';
import {useReduceMotion} from '../../lib/useReduceMotion';
import {useStyles} from '../../design/theme';
import {radius, space, type Palette} from '../../design/tokens';

// =============================================================================
// 「답하는 중」 점 셋 (#4020). 에이전트가 요청을 가져가 답을 쓰는 동안만 서는 줄의
// 표지다. 웹의 `responding-dot`과 같은 모양: 투명도만 바꾸는 파도(transform·layout 없음).
//
// 동작 줄이기가 켜져 있으면 — 아직 모르는 첫 틱도 포함해(`useReduceMotion`은 모를 때
// true다) — 움직이지 않고 멈춘 채 선다. 곁의 문장이 상태를 말하므로 정보는 그대로다.
// 보조기술에는 나가지 않는다.
//
// 점 색: 에이전트의 줄은 에이전트 표지(`color.agent`), 사람의 「작성 중」 줄(`human`)은 그 줄의 글자와 같은 흐린 잉크
// (`color.textMuted`)다(#5645, 웹 `RespondingDots human`과 같다). 정본 토큰 계약이 에이전트 색을 「아바타·배지」 —
// 에이전트를 뜻하는 자리 — 에만 두고(`clients/web/src/design/tokens.css` 머리말), 폰은 「작업 중」과 「작성 중」이
// 컴포저 위에 붙어 서는 곳이라 두 줄을 가르는 색 축이 가장 필요한 자리다.
// =============================================================================

const PERIOD_MS = 1200;
const STEP_MS = 200;
const LOW = 0.3;
const STILL = 0.6;
const DOTS = [0, 1, 2] as const;
/** 점 하나의 지름(pt). 글자 배율을 따르지 않는다. */
const DOT = 4;

/**
 * 점 셋이 줄에서 차지하는 폭(점 셋 + 사이 둘). 「작성 중」 줄이 이름 칸들의 몫을 셈할 때 뺀다(`TypingBar`, #5645) —
 * 아래 `row`·`dot` 스타일과 같은 수에서 나온다.
 */
export const RESPONDING_DOTS_WIDTH = DOTS.length * DOT + (DOTS.length - 1) * space.xs;

/** 점 셋. `human`은 사람의 「작성 중」 줄이라는 뜻이다 — 점이 에이전트 색 대신 흐린 잉크다. */
export function RespondingDots({human = false}: {human?: boolean} = {}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const reduceMotion = useReduceMotion();
  const values = useRef(DOTS.map(() => new Animated.Value(LOW))).current;
  useEffect(() => {
    if (reduceMotion) {
      values.forEach(v => v.setValue(STILL));
      return;
    }
    const loops = values.map((value, index) => {
      value.setValue(LOW);
      // 점마다 시작이 STEP_MS씩 늦고, 주기는 같다(지연 + 오름 + 내림 + 꼬리 = PERIOD_MS).
      const rise = (PERIOD_MS - STEP_MS * (DOTS.length - 1)) / 2;
      return Animated.loop(
        Animated.sequence([
          Animated.delay(index * STEP_MS),
          Animated.timing(value, {
            toValue: 1,
            duration: rise,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(value, {
            toValue: LOW,
            duration: rise,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.delay((DOTS.length - 1 - index) * STEP_MS),
        ]),
      );
    });
    loops.forEach(loop => loop.start());
    return () => loops.forEach(loop => loop.stop());
  }, [reduceMotion, values]);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.row}
      testID="responding-dots">
      {values.map((opacity, index) => (
        <Animated.View
          key={DOTS[index]}
          style={[styles.dot, human && styles.dotHuman, {opacity}]}
          testID={`responding-dot-${reduceMotion ? 'still' : 'moving'}`}
        />
      ))}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    row: {flexDirection: 'row', alignItems: 'center', gap: space.xs, alignSelf: 'center'},
    dot: {width: DOT, height: DOT, borderRadius: radius.pill, backgroundColor: color.agent},
    dotHuman: {backgroundColor: color.textMuted},
  });
