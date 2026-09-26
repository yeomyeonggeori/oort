// =============================================================================
// 코메토 안내자 · 진행 점 · 새벽하늘 바닥 — 폰 (ADR-0193 D10·D11, #2807 OB2-1).
//
// 웹 `KomettoGuide`·`OnboardingDots`·`OnboardingFrame`의 폰 짝이다. 표는 core
// (`@momo/core/features/onboarding/guide`) 한 곳을 두 클라이언트가 같이 읽는다.
// 화면에 붙이는 일(M0 환영 #2819, M3 알림 미리 안내 #2820)은 후속 이슈 몫이다.
//
// 값은 시안 `claudedocs/onboarding-2.0/mockups.html`의 CSS다(`ONBOARDING` 줄마다).
// 히어로는 폰 200(D11), 바닥 가운데 정지점은 폰 46%(`.phone.T{--stop:46%}`).
// =============================================================================

import React, {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {
  assertGuideLine,
  type KomettoExpression,
  type OnboardingDots as OnboardingDotsModel,
} from '@momo/core/features/onboarding/guide';

import {useStyles} from '../../design/theme';
import {ds2Type, type Palette} from '../../design/tokens';
import {useReduceMotion} from '../../lib/useReduceMotion';
import {KOMETTO_EXPRESSION_ASSETS} from './komettoExpressions';

/** 시안 CSS 값. 줄마다 원문. */
export const ONBOARDING = {
  /** `.guide .k{width:72px;height:72px}` */
  head: 72,
  /** D11 폰 히어로 200 (`.hero-k` 폰 200) */
  hero: 200,
  /** `.guide{gap:12px}` */
  guideGap: 12,
  /** `.bubble{border-radius:18px 18px 18px 6px}` */
  bubbleRadius: 18,
  bubbleTail: 6,
  /** `.bubble{padding:12px 16px}` */
  bubblePadV: 12,
  bubblePadH: 16,
  /** `.bubble small{margin-top:3px}` */
  detailGap: 3,
  /** `.dots i{width:6px;height:6px;border-radius:3px}` · `.dots{gap:6px}` */
  dot: 6,
  /** `.dots i.on{width:26px}` */
  dotBar: 26,
  /** `.phone.T{--stop:46%}` */
  canvasStop: '46%',
  /** D11 크로스페이드 120 · 흔들기 360 (웹 `--motion-instant`, ×3) */
  crossfadeMs: 120,
  wagMs: 360,
} as const;

export type KomettoGuideSize = 'head' | 'hero';

// ---- 얼굴 --------------------------------------------------------------------

/**
 * 코메토 얼굴. 상자 크기가 고정이고 두 겹이 같은 자리에 겹친다(제자리).
 * 표정이 바뀌면 120ms 크로스페이드, 기쁨으로 **바뀔 때** 한 번 흔든다(360ms).
 * 「동작 줄이기」면 앞 표정 겹을 만들지 않고 흔들지도 않는다. 그림은 장식이다.
 */
export function KomettoFace({
  expression,
  size = 'head',
}: {
  expression: KomettoExpression;
  size?: KomettoGuideSize;
}): React.JSX.Element {
  const reduceMotion = useReduceMotion();
  const [shown, setShown] = useState(expression);
  const [leaving, setLeaving] = useState<KomettoExpression | null>(null);
  const fade = useRef(new Animated.Value(1)).current;
  const wag = useRef(new Animated.Value(0)).current;
  const side = size === 'hero' ? ONBOARDING.hero : ONBOARDING.head;

  if (shown !== expression) {
    setShown(expression);
    setLeaving(reduceMotion ? null : shown);
  }

  // 겹이 처음 그려지기 전에 0에서 시작한다(한 프레임이라도 새 표정이 먼저 차오르지 않게).
  useLayoutEffect(() => {
    if (leaving === null) return;
    fade.setValue(0);
    const run = Animated.timing(fade, {
      toValue: 1,
      duration: ONBOARDING.crossfadeMs,
      easing: Easing.linear,
      useNativeDriver: true,
    });
    run.start(() => setLeaving(null));
    return () => run.stop();
  }, [leaving, fade]);

  const [wagging, setWagging] = useState(false);
  const previous = useRef(expression);
  useEffect(() => {
    const was = previous.current;
    previous.current = expression;
    if (was === expression || expression !== 'happy' || reduceMotion) return;
    setWagging(true);
    wag.setValue(0);
    const run = Animated.timing(wag, {
      toValue: 1,
      duration: ONBOARDING.wagMs,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    });
    run.start(() => setWagging(false));
    return () => run.stop();
  }, [expression, reduceMotion, wag]);

  const rotate = wag.interpolate({
    inputRange: [0, 0.25, 0.6, 1],
    outputRange: ['0deg', '-6deg', '5deg', '0deg'],
  });

  return (
    <Animated.View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="kometto-face"
      style={[
        faceStyles.box,
        {width: side, height: side},
        wagging ? {transform: [{rotate}]} : null,
      ]}>
      {leaving !== null ? (
        <Animated.Image
          testID="kometto-face-leaving"
          source={KOMETTO_EXPRESSION_ASSETS[leaving]}
          style={[
            StyleSheet.absoluteFill,
            {width: side, height: side, opacity: Animated.subtract(1, fade)},
          ]}
          resizeMode="contain"
        />
      ) : null}
      <Animated.Image
        testID="kometto-face-current"
        source={KOMETTO_EXPRESSION_ASSETS[shown]}
        style={[
          StyleSheet.absoluteFill,
          {width: side, height: side},
          leaving !== null ? {opacity: fade} : null,
        ]}
        resizeMode="contain"
      />
    </Animated.View>
  );
}

const faceStyles = StyleSheet.create({
  // 꼬리가 있는 아래쪽을 축으로 흔든다. 한 장짜리 래스터라 꼬리만 떼어 돌릴 수 없다.
  box: {transformOrigin: '50% 85%'},
});

// ---- 안내자 -------------------------------------------------------------------

/**
 * 코메토 머리(72) 또는 히어로(200) + 말풍선 한 문장. `line`이 비면 던진다.
 *
 * 스크린리더(VoiceOver): 마운트 때 문장은 읽는 순서대로 한 번 읽힌다(`header`면
 * 화면 제목). 같은 화면에서 문장이 바뀌면 바뀐 문장을 한 번 알린다
 * (`announceForAccessibility`, iOS에는 live region이 없다). 코메토 그림은 숨긴다.
 */
export function KomettoGuide({
  expression,
  line,
  detail,
  size = 'head',
  header = false,
  style,
}: {
  expression: KomettoExpression;
  line: string;
  detail?: string;
  size?: KomettoGuideSize;
  /** 이 문장이 화면의 질문(제목)인가. */
  header?: boolean;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const text = assertGuideLine(line);
  const styles = useStyles(buildStyles);
  const spoken = detail ? `${text} ${detail}` : text;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    AccessibilityInfo.announceForAccessibility(spoken);
  }, [spoken]);

  const hero = size === 'hero';
  return (
    <View
      style={[hero ? styles.guideHero : styles.guide, style]}
      testID="kometto-guide">
      <KomettoFace expression={expression} size={size} />
      <View
        style={[styles.bubble, hero && styles.bubbleHero]}
        testID="kometto-guide-bubble"
        accessible
        accessibilityRole={header ? 'header' : 'text'}
        accessibilityLabel={spoken}>
        <Text style={[styles.line, hero && styles.center]} testID="kometto-guide-line">
          {text}
        </Text>
        {detail ? (
          <Text style={[styles.detail, hero && styles.center]} testID="kometto-guide-detail">
            {detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

// ---- 진행 점 -----------------------------------------------------------------

/**
 * 진행 점. 현재 칸 신호색 막대, 지난 칸 흐린 잉크, 남은 칸 옅은 점(시안 `.dots`).
 * 모델이 null(첫 화면·첫 대화)이면 그리지 않는다. VoiceOver는 「4단계 중 2단계」.
 */
export function OnboardingDots({
  dots,
}: {
  dots: OnboardingDotsModel | null;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  if (dots === null) return null;
  return (
    <View
      style={styles.dots}
      accessible
      accessibilityRole="text"
      accessibilityLabel={dots.label}
      testID="onboarding-dots">
      {dots.dots.map((state, index) => (
        <View
          key={index}
          testID={`onboarding-dot-${state}`}
          style={[
            styles.dot,
            state === 'done' && styles.dotDone,
            state === 'current' && styles.dotCurrent,
          ]}
        />
      ))}
    </View>
  );
}

// ---- 바닥 ---------------------------------------------------------------------

/** 새벽하늘 바닥(시안 `.canvas`, 180° · 46%). 그라데이션을 못 그리면 가운데 평면이다. */
export function OnboardingCanvas({
  children,
  style,
}: {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={[styles.canvas, style]} testID="onboarding-canvas">
      {children}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    canvas: {
      flex: 1,
      backgroundColor: color.bg,
      experimental_backgroundImage: `linear-gradient(180deg, ${color.canvasTop} 0%, ${color.bg} ${ONBOARDING.canvasStop}, ${color.canvasBottom} 100%)`,
    },
    guide: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: ONBOARDING.guideGap,
    },
    guideHero: {
      alignItems: 'center',
      gap: ONBOARDING.guideGap,
    },
    bubble: {
      flexShrink: 1,
      backgroundColor: color.surface,
      borderTopLeftRadius: ONBOARDING.bubbleRadius,
      borderTopRightRadius: ONBOARDING.bubbleRadius,
      borderBottomRightRadius: ONBOARDING.bubbleRadius,
      borderBottomLeftRadius: ONBOARDING.bubbleTail,
      paddingVertical: ONBOARDING.bubblePadV,
      paddingHorizontal: ONBOARDING.bubblePadH,
      boxShadow: color.elevationRest,
    },
    bubbleHero: {
      borderBottomLeftRadius: ONBOARDING.bubbleRadius,
    },
    line: {
      color: color.text,
      fontSize: ds2Type.body,
      fontWeight: '600',
      letterSpacing: -0.16,
    },
    detail: {
      marginTop: ONBOARDING.detailGap,
      color: color.textMuted,
      fontSize: ds2Type.subhead,
    },
    center: {textAlign: 'center'},
    dots: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: ONBOARDING.dot,
    },
    dot: {
      width: ONBOARDING.dot,
      height: ONBOARDING.dot,
      borderRadius: ONBOARDING.dot / 2,
      // 남은 칸 = core `line-strong`(폰 `textFaint`). 시안의 mutedSoft는 바닥 위 약 1.1:1이라
      // 비텍스트 3:1(WCAG 1.4.11)을 못 넘는다. 표는 core `ONBOARDING_DOT_ROLES`(#2807 M3).
      backgroundColor: color.textFaint,
    },
    dotDone: {backgroundColor: color.textMuted},
    dotCurrent: {width: ONBOARDING.dotBar, backgroundColor: color.accent},
  });
