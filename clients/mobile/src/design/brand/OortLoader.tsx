import React, {useEffect, useMemo, useRef} from 'react';
import {
  Animated,
  Easing,
  StyleSheet,
  type ImageSourcePropType,
  type ViewStyle,
} from 'react-native';
import {useReduceMotion} from '../../lib/useReduceMotion';
import {usePalette} from '../theme';
import {
  LOADER_PERIOD_MS,
  OPTICAL,
  opticalFor,
  PHASE,
  TRAILS,
  TRAIL_MIN_SIZE,
  tablesFor,
  type Knot,
} from './oortLoaderTimeline';

// =============================================================================
// 오르트 로더 (#3961, 시안 A 「공전」). 연결이 끊겼거나 다시 연결하는 중, 첫 로딩,
// 그리고 당겨서 새로고침(#3962)에서 도는 브랜드 표시다. owner 2026-10-17:
// 「A가 심플하고 좋아보이네. A 방향으로 가자.」
//
// 링(사람·팀)은 가만히 있고, 위성(에이전트)이 홈에서 나와 한 바퀴 돌고 다시 꽂힌다.
// 웹 `OortLoader`(`clients/web/src/design/brand/OortLoader.tsx`)와 같은 움직임이다.
// 폰에는 `react-native-svg` 가 없으므로(새 네이티브 의존은 범위 밖) 링은 마크 정본 path 를
// 떠낸 PNG 에 `tintColor` 를 입히고, 위성은 원(`View`)이다 — 원이라 기하가 같다.
// 래스터는 `oort-loader-ring-{small,display}[@2x|@3x].png`: 마크 정본 링 path 만(위성 없음)
// 무대(정사각, 링 중심 = 무대 중심) 크기로 뜬 것이고, 코메토 배지처럼
// `render-brand-icons.mjs` 의 검사 밖이다. 다시 만드는 법은 `oortLoaderRasters.test.ts` 머리말.
//
// ## 움직이는 것은 transform 과 opacity 뿐
//
// 코어 `Animated` + `useNativeDriver` 라 JS 스레드가 바빠도 돈다(`design/motion.ts`
// 머리말: Reanimated 는 들이지 않았다). 시간표는 `oortLoaderTimeline.ts` 한 곳이고,
// 회전·이동·링 숨·꼬리 점이 **한 시계**(`clock`)에서 읽힌다.
//
// ## 세 갈래
//
//   움직임        위성이 홈에서 나와 돈다.
//   동작 줄이기   iOS 「동작 줄이기」가 켜져 있으면 회전 대신 정지한 마크 + 투명도 1↔0.5.
//                 첫 답이 오기 전에는 켜진 것으로 본다(`useReduceMotion`).
//   정지(still)   진행 중이 아닌 자리. 위성을 홈에 꽂은 마크, 투명도도 그대로.
//
// ## 당김(progress) — #3962 가 쓴다
//
// `progress`(0~1, 당긴 거리)를 주면 로더는 돌지 않고 **그 거리만큼 위성이 튀어나온 자세**로
// 선다(시간표의 처음 14% 를 손가락으로 되감는다). `spinning` 이 켜지면 그 자세에서 이어
// 돈다: 시작 위상이 14% 이고 시간표가 주기 함수라 이음새가 없다.
//
// ## 모드가 바뀌면 바디를 새로 세운다 (`key`)
//
// 네이티브 드라이버로 돌기 시작한 뒤 **같은** `Animated.View` 의 스타일 그래프를 바꾸면
// (동작 줄이기 첫 답이 늦게 도착해 투명도 시계에서 회전 시계로 갈아타는 경우) 네이티브 쪽
// 노드 연결이 갱신되지 않는 일이 있다. 시뮬레이터에서 위성이 홈에 선 채 투명도만 숨 쉬는 모습으로
// 굳었고, 부모가 우연히 다시 그려지는 화면에서만 풀렸다(2026-10-17 캡처에서 발견, jest 는 JS
// 드라이버라 못 본다). 그래서 모드(정지·당김·숨·돎)마다 새 바디, 곧 새 `Animated` 노드를 세운다:
// 한 바디의 그래프는 수명 동안 바뀌지 않는다. 대가는 첫 답이 오는 한 틱에 바디가 한 번 갈리는 것뿐이고,
// 두 바디 모두 홈에서 시작하므로 눈에는 보이지 않는다.
//
// 항상 장식이다(접근성 트리에서 숨김). 로더가 서는 자리의 문장(「연결 중…」)이 이름을 진다.
// =============================================================================

const RING: Record<'small' | 'display', ImageSourcePropType> = {
  small: require('./oort-loader-ring-small.png') as ImageSourcePropType,
  display: require('./oort-loader-ring-display.png') as ImageSourcePropType,
};

export interface OortLoaderProps {
  /** 정사각 무대의 한 변(pt). 32 이하는 small 마크, 그보다 크면 display 마크(40 부터 꼬리 점). */
  size?: number;
  /** 진행 중이 아니다: 위성을 홈에 꽂은 정지 마크. */
  still?: boolean;
  /**
   * 당긴 거리(0~1). 주면 `spinning` 이 켜지기 전까지 돌지 않고 거리에 따라 위성이 튀어나온다.
   * 0 이면 홈에 꽂혀 있고 1 이면 궤도에 나와 있다.
   */
  progress?: Animated.Value;
  /** `progress` 와 함께: 새로고침이 시작됐다. 당긴 자세에서 이어 돈다. 기본 false. */
  spinning?: boolean;
  /** 링 색. 기본은 본문 잉크. 위성은 항상 신호색이다. */
  color?: string;
  testID?: string;
}

const ranges = (knots: readonly Knot[], scale = 1) => ({
  inputRange: knots.map(k => k[0]),
  outputRange: knots.map(k => k[1] * scale),
});

type LoaderMode = 'still' | 'scrub' | 'breathe' | 'spin';

export function OortLoader(props: OortLoaderProps): React.JSX.Element {
  const reduceMotion = useReduceMotion();
  const scrubbing = props.progress !== undefined && !(props.spinning ?? false);
  const mode: LoaderMode = props.still
    ? 'still'
    : scrubbing
      ? 'scrub'
      : reduceMotion
        ? 'breathe'
        : 'spin';
  // `key` 가 모드라서 모드가 바뀌면 바디가 새로 선다(헤더 「모드가 바뀌면 바디를 새로 세운다」).
  return <LoaderBody key={mode} mode={mode} {...props} />;
}

function LoaderBody({
  mode,
  size = 24,
  progress,
  color,
  testID = 'oort-loader',
}: OortLoaderProps & {mode: LoaderMode}): React.JSX.Element {
  const palette = usePalette();
  const optical = opticalFor(size);
  const geometry = OPTICAL[optical];
  const tables = useMemo(() => tablesFor(optical), [optical]);

  /** 시계가 도는 모드: 움직임과 동작 줄이기(투명도 숨). 정지와 당김은 시계가 서 있다. */
  const running = mode === 'spin' || mode === 'breathe';
  const full = mode === 'spin';
  const breathing = mode === 'breathe';
  const scrubbing = mode === 'scrub';
  /** 당김에서 이어 도는 로더는 위성이 다 나온 14% 에서 시작한다. */
  const startPhase = progress !== undefined ? PHASE.popEnd : 0;

  const clock = useRef(new Animated.Value(0)).current;
  const zero = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!running) return;
    clock.setValue(startPhase);
    // 한 번의 네이티브 반복(JS 를 건너뛴다). 시작 위상 `a` 에서 `a + 1` 까지가 한 주기이고
    // 시간표가 주기 함수라 반복의 이음새도 그 자리에서 이어진다.
    const loop = Animated.loop(
      Animated.timing(clock, {
        toValue: startPhase + 1,
        duration: LOADER_PERIOD_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [running, startPhase, clock]);

  const scrubClock = useMemo(
    () =>
      progress
        ? progress.interpolate({
            inputRange: [0, 1],
            outputRange: [0, PHASE.popEnd],
            extrapolate: 'clamp',
          })
        : null,
    [progress],
  );

  /** 위성·링의 자세를 읽는 시계: 움직임이면 반복 시계, 당김이면 거리, 그 밖에는 홈(0). */
  const poseClock = full ? clock : scrubbing && scrubClock ? scrubClock : zero;
  /** 투명도 숨은 동작 줄이기에서만 시계를 읽는다. */
  const breatheClock = breathing ? clock : zero;

  const dotDiameter = (size * 2 * geometry.satelliteRadius) / geometry.units;
  const withTrails = full && size >= TRAIL_MIN_SIZE;

  const motion = useMemo(() => {
    const radial = ranges(tables.radial, size);
    const angle = ranges(tables.angle);
    const trailAngle = (offset: number) => ({
      inputRange: angle.inputRange,
      outputRange: angle.outputRange.map(v => `${v - offset}deg`),
    });
    return {
      translateX: poseClock.interpolate(radial),
      rotate: poseClock.interpolate({
        inputRange: angle.inputRange,
        outputRange: angle.outputRange.map(v => `${v}deg`),
      }),
      scale: poseClock.interpolate(ranges(tables.ring)),
      opacity: breatheClock.interpolate(ranges(tables.breathe)),
      trails: TRAILS.map(trail => ({
        rotate: poseClock.interpolate(trailAngle(trail.offset)),
        opacity: poseClock.interpolate(ranges(tables.trail(trail.opacity))),
        diameter: dotDiameter * trail.scale,
      })),
    };
  }, [poseClock, breatheClock, tables, size, dotDiameter]);

  const dot = (
    diameter: number,
    extra: Animated.WithAnimatedValue<ViewStyle>,
    key: string,
  ) => (
    <Animated.View
      key={key}
      testID={`${testID}-${key}`}
      style={[
        dotBase,
        {
          width: diameter,
          height: diameter,
          borderRadius: diameter / 2,
          left: (size - diameter) / 2,
          top: (size - diameter) / 2,
          backgroundColor: palette.accent,
        },
        extra,
      ]}
    />
  );

  return (
    <Animated.View
      // 장식이다: 이름은 곁의 문장이 진다.
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      testID={testID}
      style={{width: size, height: size, opacity: motion.opacity}}>
      {/* 위성 층이 링보다 먼저(그리는 순서)라 링이 위에 선다: 위성이 말풍선 꼬리 뒤로 지나간다. */}
      {withTrails &&
        motion.trails.map((trail, index) =>
          dot(
            trail.diameter,
            {
              opacity: trail.opacity,
              transform: [{rotate: trail.rotate}, {translateX: motion.translateX}],
            },
            `trail-${index}`,
          ),
        )}
      {dot(
        dotDiameter,
        {transform: [{rotate: motion.rotate}, {translateX: motion.translateX}]},
        'satellite',
      )}
      <Animated.Image
        source={RING[optical]}
        testID={`${testID}-ring`}
        style={[
          StyleSheet.absoluteFill,
          {
            width: size,
            height: size,
            tintColor: color ?? palette.text,
            transform: [{scale: motion.scale}],
          },
        ]}
      />
    </Animated.View>
  );
}

/** 위성 원의 공통 자리: 무대 안에 떠서 transform 만 움직인다. */
const dotBase: ViewStyle = {position: 'absolute'};
