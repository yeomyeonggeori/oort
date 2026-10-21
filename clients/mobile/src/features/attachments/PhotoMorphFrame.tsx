import React, {useEffect, useRef, useState} from 'react';
import {Animated, Easing, StyleSheet} from 'react-native';

import {useReduceMotionRef} from '../../lib/useReduceMotion';
import {PHOTO_MORPH, type PhotoCardSize} from './photoCardDesign';
import type {MorphTarget} from './photoMorph';

// =============================================================================
// 변신 틀 — 첨부 메뉴가 사진 카드로 자라고, 뒤로 가면 다시 메뉴로 접힌다 (#4181 Goal 3).
//
// Buzz IMG_4320 → IMG_4321: 메뉴(폭 ≈215 · 높이 ≈322 · 모서리 ≈27)가 카드(폭 ≈382 · 높이
// ≈372 · 모서리 ≈32)로 **변신**한다. 틀의 바닥·왼쪽은 고정이고 폭·높이·모서리가 하나의
// 진행 값(0=메뉴, 1=카드)을 따라 간다. 안쪽은 두 층이 겹쳐 있다:
//
//   메뉴 층  진행 0→0.5 에 사라지며 왼쪽 위로 접혀 든다(배율 → `menuEndScale`)
//   카드 층  진행 0.35→0.9 에 나타나며 자란다(배율 `cardStartScale` → 1)
//
// 폭·높이·모서리는 네이티브 드라이버로 움직일 수 없다(레이아웃 속성). 그래서 이 진행은
// **JS 구동** `Animated.spring` 이다 — 새 애니메이션 의존성 없이 RN 내장만(이슈 Goal 3).
// 300ms 안팎의 한 번짜리 움직임이고, 그 사이 JS 스레드가 하는 일은 이 틀의 보간뿐이다:
// 사진 층은 `opacity` 가 0 일 때도 마운트돼 있으므로 썸네일 디코드는 변신 중에 시작되지만,
// 그리드는 `FlatList` 의 첫 12칸만 그린다.
//
// 「동작 줄이기」: 크기는 즉시 목표로 가고 두 층만 `fadeMs` 동안 서로 바뀐다 — 모션을 끄는
// 것이 아니라 0 으로 만든다(모션 사다리 D9, 상태는 착지한다).
// =============================================================================

export interface PhotoMorphFrameProps {
  target: MorphTarget;
  menuSize: PhotoCardSize;
  menuRadius: number;
  cardSize: PhotoCardSize;
  cardRadius: number;
  /** 메뉴 내용. `menuSize` 고정 크기로 틀의 왼쪽 아래에 놓인다. */
  menu: React.ReactNode;
  /** 카드 내용. `cardSize` 고정 크기로 틀의 왼쪽 아래에 놓인다. */
  card: React.ReactNode;
  /** 스프링이 목표에 닿았다(끊기지 않고 끝났다). */
  onSettled?: (target: MorphTarget) => void;
  /** 캡처 하네스: 진행을 이 값(0..1)에 못 박는다. 중간 프레임을 결정적으로 찍는 길이다. */
  pinnedProgress?: number;
  testID?: string;
}

const CLAMP = 'clamp' as const;

export function PhotoMorphFrame({
  target,
  menuSize,
  menuRadius,
  cardSize,
  cardRadius,
  menu,
  card,
  onSettled,
  pinnedProgress,
  testID = 'photo-morph',
}: PhotoMorphFrameProps): React.JSX.Element {
  const reduceMotion = useReduceMotionRef();
  const progress = useRef(
    new Animated.Value(pinnedProgress ?? (target === 'card' ? 1 : 0)),
  ).current;
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  // 이번 이동이 「동작 줄이기」였는가. 그 값이 크기를 정하므로 렌더에 보여야 한다.
  const [reduced, setReduced] = useState(false);
  // 마운트는 이동이 아니다. 처음 자세가 곧 목표라서 스프링을 걸면 「도착」을 헛되이 알린다.
  const arrived = useRef(false);

  useEffect(() => {
    if (pinnedProgress !== undefined) {
      progress.setValue(pinnedProgress);
      return undefined;
    }
    if (!arrived.current) {
      arrived.current = true;
      return undefined;
    }
    const to = target === 'card' ? 1 : 0;
    const instant = reduceMotion.current;
    setReduced(instant);
    const animation = instant
      ? Animated.timing(progress, {
          toValue: to,
          duration: PHOTO_MORPH.fadeMs,
          easing: Easing.out(Easing.quad),
          useNativeDriver: false,
        })
      : Animated.spring(progress, {
          toValue: to,
          ...PHOTO_MORPH.spring,
          useNativeDriver: false,
        });
    animation.start(({finished}) => {
      if (finished) onSettledRef.current?.(target);
    });
    return () => animation.stop();
  }, [target, pinnedProgress, progress, reduceMotion]);

  const toCard = target === 'card';
  const width =
    reduced && pinnedProgress === undefined
      ? toCard
        ? cardSize.width
        : menuSize.width
      : progress.interpolate({
          inputRange: [0, 1],
          outputRange: [menuSize.width, cardSize.width],
          extrapolate: CLAMP,
        });
  const height =
    reduced && pinnedProgress === undefined
      ? toCard
        ? cardSize.height
        : menuSize.height
      : progress.interpolate({
          inputRange: [0, 1],
          outputRange: [menuSize.height, cardSize.height],
          extrapolate: CLAMP,
        });
  const borderRadius =
    reduced && pinnedProgress === undefined
      ? toCard
        ? cardRadius
        : menuRadius
      : progress.interpolate({
          inputRange: [0, 1],
          outputRange: [menuRadius, cardRadius],
          extrapolate: CLAMP,
        });

  const [menuFrom, menuTo] = PHOTO_MORPH.menuFade;
  const [cardFrom, cardTo] = PHOTO_MORPH.cardFade;
  const menuOpacity = progress.interpolate({
    inputRange: [menuFrom, menuTo],
    outputRange: [1, 0],
    extrapolate: CLAMP,
  });
  const menuScale = progress.interpolate({
    inputRange: [menuFrom, menuTo],
    outputRange: [1, PHOTO_MORPH.menuEndScale],
    extrapolate: CLAMP,
  });
  // 틀은 위로 자라고 메뉴 층은 바닥에 닻이 있다. 메뉴의 윗변이 틀의 윗변에 붙어 올라가도록
  // 틀이 자란 만큼(`진행 × (카드 높이 − 메뉴 높이)`) 끌어올린다 — 줄어드는 메뉴가 카드의
  // 왼쪽 위 모서리에 매달려 접혀 든다(Buzz 중간 프레임).
  const menuLift = progress.interpolate({
    inputRange: [menuFrom, menuTo],
    outputRange: [
      menuFrom * (menuSize.height - cardSize.height),
      menuTo * (menuSize.height - cardSize.height),
    ],
    extrapolate: CLAMP,
  });
  const cardOpacity = progress.interpolate({
    inputRange: [cardFrom, cardTo],
    outputRange: [0, 1],
    extrapolate: CLAMP,
  });
  const cardScale = progress.interpolate({
    inputRange: [cardFrom, 1],
    outputRange: [PHOTO_MORPH.cardStartScale, 1],
    extrapolate: CLAMP,
  });

  return (
    <Animated.View
      style={[styles.frame, {width, height, borderRadius}]}
      testID={testID}>
      <Animated.View
        accessibilityElementsHidden={toCard}
        importantForAccessibility={toCard ? 'no-hide-descendants' : 'auto'}
        pointerEvents={toCard ? 'none' : 'auto'}
        style={[
          styles.menuLayer,
          {
            width: menuSize.width,
            height: menuSize.height,
            opacity: menuOpacity,
            transform: [{translateY: menuLift}, {scale: menuScale}],
          },
        ]}
        testID={`${testID}-menu`}>
        {menu}
      </Animated.View>
      <Animated.View
        accessibilityElementsHidden={!toCard}
        importantForAccessibility={toCard ? 'auto' : 'no-hide-descendants'}
        pointerEvents={toCard ? 'auto' : 'none'}
        style={[
          styles.cardLayer,
          {
            width: cardSize.width,
            height: cardSize.height,
            opacity: cardOpacity,
            transform: [{scale: cardScale}],
          },
        ]}
        testID={`${testID}-card`}>
        {card}
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // 틀은 안을 자른다. 그림자는 호스트가 바깥에서 둘러 준다.
  frame: {overflow: 'hidden'},
  // 두 층 모두 틀의 왼쪽 아래에 닻을 내린다 — 틀이 위·오른쪽으로 자란다. 메뉴는 왼쪽 위
  // 모서리를 축으로 줄어들고(카드의 왼쪽 위 칸으로 접혀 든다), 카드는 아래 가운데를 축으로 자란다.
  menuLayer: {position: 'absolute', left: 0, bottom: 0, transformOrigin: 'left top'},
  cardLayer: {position: 'absolute', left: 0, bottom: 0, transformOrigin: 'center bottom'},
});
