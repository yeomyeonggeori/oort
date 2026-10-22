import React, {useEffect, useRef, useState} from 'react';
import {Animated, Easing, View, type StyleProp, type ViewStyle} from 'react-native';

import {useReduceMotionRef} from '../../lib/useReduceMotion';
import {MorphEdgeContext, type MorphEdgeShift} from './morphEdge';
import {PHOTO_MORPH, type PhotoCardSize} from './photoCardDesign';
import type {MorphTarget} from './photoMorph';

// =============================================================================
// 변신 틀 — 첨부 메뉴가 사진 카드로 자라고, 뒤로 가면 다시 메뉴로 접힌다 (#4181 Goal 3).
//
// Buzz IMG_4320 → IMG_4321: 메뉴(폭 ≈215 · 높이 ≈322 · 모서리 ≈27)가 카드(폭 ≈382 · 높이
// ≈372 · 모서리 ≈32)로 **변신**한다. 틀의 바닥·왼쪽은 고정이고 폭·높이·모서리가 하나의
// 진행 값(0=메뉴, 1=카드)을 따라 간다. 틀 안은 몸통 위에 두 층이 있다(구간은 `PHOTO_MORPH`):
//
//   몸통     카드 면 색. 가장 먼저(`bodyFade`) 올라와 틀 안을 막는다 — 비치는 곳이 없다
//   메뉴 층  `menuFade` 에 사라지며 왼쪽 위로 접혀 든다(배율 → `menuEndScale`)
//   카드 층  `cardFade` 에 나타나며 자란다(배율 `cardStartScale` → 1). 메뉴가 걷히는 끝에 이어 선다
//
// 폭·높이·모서리는 네이티브 드라이버로 움직일 수 없다(레이아웃 속성). 그래서 이 진행은
// **JS 구동** `Animated.spring` 이다 — 새 애니메이션 의존성 없이 RN 내장만(이슈 Goal 3).
// 300ms 안팎의 한 번짜리 움직임이고, 그 사이 JS 스레드가 하는 일은 이 틀의 보간뿐이다:
// 사진 층은 `opacity` 가 0 일 때도 마운트돼 있으므로 썸네일 디코드는 변신 중에 시작되지만,
// 그리드는 `FlatList` 의 첫 12칸만 그린다.
//
// 「동작 줄이기」: 크기는 즉시 목표로 가고, 메뉴·사진 층은 제자리에서(이동·배율 없이) `fadeMs` 동안
// 투명도만 서로 바뀐다 — 모션을 끄는 것이 아니라 0 으로 만든다(모션 사다리 D9, 상태는 착지한다).
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
  /**
   * 카드 층 위에 **아무것도 안 하는 덮개**를 얹어 누름을 삼킨다(연타 방어). 「사진」 행을 두 번 누르는 손의 둘째
   * 탭은 같은 자리의 카드 칸에 떨어지는데, 카드는 첫 프레임부터 눌려서 사진이 하나 골라졌다. 덮개가 없으면 그
   * 탭은 뒤의 바깥 표면으로 새지 않는다 — 카드 층이 누름을 받기 때문이다.
   */
  cardGuarded?: boolean;
  /** 틀 바깥 꾸밈(그림자). 틀은 안을 자르지만 `boxShadow` 는 자기 `overflow` 에 잘리지 않는다. */
  frameStyle?: StyleProp<ViewStyle>;
  /**
   * 몸통 색(카드 면 색). 진행 `bodyFade` 동안 올라와 틀 전체를 막는다. 두 층은 서로 다른 구간에서
   * 불투명해지므로 몸통 없이는 메뉴가 덮지 않는 띠로 뒤 대화가 비친다(design-review H1). 없으면 투명.
   */
  bodyColor?: string;
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
  cardGuarded,
  frameStyle,
  bodyColor,
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
  // 「동작 줄이기」: 크기도 위치도 배율도 움직이지 않는다 — 두 층이 제자리에서 투명도만 서로 바뀐다.
  const still = reduced && pinnedProgress === undefined;
  const width =
    still
      ? toCard
        ? cardSize.width
        : menuSize.width
      : progress.interpolate({
          inputRange: [0, 1],
          outputRange: [menuSize.width, cardSize.width],
          extrapolate: CLAMP,
        });
  const height =
    still
      ? toCard
        ? cardSize.height
        : menuSize.height
      : progress.interpolate({
          inputRange: [0, 1],
          outputRange: [menuSize.height, cardSize.height],
          extrapolate: CLAMP,
        });
  const borderRadius =
    still
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
  const menuScale = still
    ? 1
    : progress.interpolate({
        inputRange: [menuFrom, menuTo],
        outputRange: [1, PHOTO_MORPH.menuEndScale],
        extrapolate: CLAMP,
      });
  // 틀은 위로 자라고 메뉴 층은 바닥에 닻이 있다. 메뉴의 윗변이 틀의 윗변에 붙어 올라가도록
  // 틀이 자란 만큼(`진행 × (카드 높이 − 메뉴 높이)`) 끌어올린다 — 줄어드는 메뉴가 카드의
  // 왼쪽 위 모서리에 매달려 접혀 든다(Buzz 중간 프레임).
  const menuLift = still
    ? 0
    : progress.interpolate({
        inputRange: [0, menuTo],
        outputRange: [0, menuTo * (menuSize.height - cardSize.height)],
        extrapolate: CLAMP,
      });
  // 카드 안 오른쪽 닻 컨트롤이 틀의 오른쪽 가장자리를 따라가게 하는 가로 이동(`morphEdge.ts`).
  const edgeShift: MorphEdgeShift = still
    ? 0
    : progress.interpolate({
        inputRange: [0, 1],
        outputRange: [menuSize.width - cardSize.width, 0],
        extrapolate: CLAMP,
      });
  const [bodyFrom, bodyTo] = PHOTO_MORPH.bodyFade;
  const bodyOpacity = progress.interpolate({
    inputRange: [bodyFrom, bodyTo],
    outputRange: [0, 1],
    extrapolate: CLAMP,
  });
  const cardOpacity = progress.interpolate({
    inputRange: [cardFrom, cardTo],
    outputRange: [0, 1],
    extrapolate: CLAMP,
  });
  const cardScale = still
    ? 1
    : progress.interpolate({
        inputRange: [cardFrom, 1],
        outputRange: [PHOTO_MORPH.cardStartScale, 1],
        extrapolate: CLAMP,
      });

  return (
    <Animated.View
      style={[FRAME_STYLE, frameStyle, {width, height, borderRadius}]}
      testID={testID}>
      {bodyColor === undefined ? null : (
        <Animated.View
          pointerEvents="none"
          style={[BODY_STYLE, {backgroundColor: bodyColor, opacity: bodyOpacity}]}
          testID={`${testID}-body`}
        />
      )}
      <Animated.View
        accessibilityElementsHidden={!toCard}
        importantForAccessibility={toCard ? 'auto' : 'no-hide-descendants'}
        pointerEvents={toCard ? 'auto' : 'none'}
        style={[
          CARD_LAYER_STYLE,
          {
            width: cardSize.width,
            height: cardSize.height,
            opacity: cardOpacity,
            transform: [{scale: cardScale}],
          },
        ]}
        testID={`${testID}-card`}>
        <MorphEdgeContext.Provider value={edgeShift}>{card}</MorphEdgeContext.Provider>
        {cardGuarded === true ? <View style={GUARD_STYLE} testID={`${testID}-guard`} /> : null}
      </Animated.View>
      <Animated.View
        accessibilityElementsHidden={toCard}
        importantForAccessibility={toCard ? 'no-hide-descendants' : 'auto'}
        pointerEvents={toCard ? 'none' : 'auto'}
        style={[
          MENU_LAYER_STYLE,
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
    </Animated.View>
  );
}

// 레이아웃만 있고 색이 없다. `StyleSheet.create` 상수가 아니라 평범한 객체인 이유는 `themeSwitch.test.tsx`
// 의 규칙(즉시 부르는 `StyleSheet.create` 는 import 시점에 굳는다)을 문자 그대로 지키기 위해서다.
//
// 틀은 안을 자른다. 그림자는 호스트가 바깥에서 둘러 준다.
const FRAME_STYLE = {overflow: 'hidden', borderCurve: 'continuous'} as const;
// 몸통은 틀 전체를 채운다. 두 층 아래(첫 자식)에 서므로 메뉴·사진 층이 그 위에 얹힌다.
const BODY_STYLE = {position: 'absolute', top: 0, right: 0, bottom: 0, left: 0} as const;
// 연타 방어 덮개: 카드 층 전체를 덮고 아무 일도 하지 않는다.
const GUARD_STYLE = {position: 'absolute', top: 0, right: 0, bottom: 0, left: 0} as const;
// 두 층 모두 틀의 왼쪽 아래에 닻을 내린다 — 틀이 위·오른쪽으로 자란다. 메뉴는 왼쪽 위
// 모서리를 축으로 줄어들고(카드의 왼쪽 위 칸으로 접혀 든다), 카드는 아래 가운데를 축으로 자란다.
const MENU_LAYER_STYLE = {
  position: 'absolute',
  left: 0,
  bottom: 0,
  transformOrigin: 'left top',
} as const;
const CARD_LAYER_STYLE = {
  position: 'absolute',
  left: 0,
  bottom: 0,
  transformOrigin: 'center bottom',
} as const;
