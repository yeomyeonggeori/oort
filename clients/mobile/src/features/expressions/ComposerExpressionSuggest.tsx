import type {Expression} from '@momo/core/features/expressions/types';
import React, {useMemo, useRef} from 'react';
import {Animated, Image, PanResponder, Pressable, StyleSheet, View, type AccessibilityActionEvent} from 'react-native';
import {CONV_ICON_SIZE, CONV_ICONS} from '../../design/icons';
import {useStyles} from '../../design/theme';
import {WORD} from '../../lib/techWords';
import {ds2Radius, slopTo, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {ExpressionImage} from './ExpressionImage';
import {useExpressionMessages} from './useExpressionMessages';

// =============================================================================
// 입력창 위의 이모티콘 추천 줄 - 폰 (#5478, 웹 `ComposerExpressionSuggest.tsx` #5476 의 짝, owner 2026-11-07 「안내 글 없이 카카오톡처럼」).
//
// 글을 치다 0.3초 멈췄을 때 **방금 친 낱말**(짧은 글이면 글 전체도)이 꼬리표·이름과 맞으면 그림 몇 개(1~5)가 입력창 바로 위에 **얇게 뜬다**(#5602 M1). 서면 문구 안에서 맞은 낱말 모두가
// 낱말이 나온 차례로 한 줄에 함께 선다(#5588: 「ㅋㅋ 개웃기네 진심」의 진심에서 → ㅋㅋ 쪽 + 진심 쪽). 이 줄에는 **그림과 끝의 작은 ✕ 뿐**이다: 안내 글도 힌트 글도
// 두지 않는다(이름은 낭독용 접근성 이름에만). 언제 서는지·무엇을 보일지(맞추기·순서·꺼 둔 낱말·닫힘)는 코어 `planExpressionSuggest` 와 `useExpressionSuggest` 가 정한다. 이 파일이 더하는 것은 자리와 모양과 손짓이다.
//
// 자리: **도크 밖으로 뜬다 - 흐름에 들지 않는다.** 멘션 목록(`styles.mentions`, #3661)과 같은 자리·같은 규칙이다. 줄이 서고 사라질 때마다 흐름 안에서 높이를 먹으면 글을 치다 멈출 때마다
// 도크가 자라고 줄어서 대화 목록이 위아래로 흔들린다(「입력창이 움직이면 안 된다」, #4619·#5452). 대신 대화 목록의 아래쪽을 잠깐 덮는다. 바깥 칸은 `box-none` 이라 줄 둘레는 아래 목록이
// 그대로 받는다(줄 안은 줄이 받는다).
//
// 폭: **덮는 층은 알약 폭 전체 - 거터 안쪽 끝에서 끝까지 - 의 한 덩어리 띠다**(#5492, 검증 7b M1). 줄이 그림 수만큼만 넓은 카드(약 140~190pt)였을 때는 덮인 마지막 말풍선의 조각이 카드 옆·위로 비어져 나와
// 반쯤 잘린 말풍선처럼 읽혔다. 띠의 양쪽 바깥 여백이 알약과 같아(`marginHorizontal`, 호출한 쪽이 알약에 주는 값) 양끝이 알약의 양쪽 가장자리와 맞고, 그림은 왼쪽부터 서고(자리·크기 그대로) ✕ 는 owner 목업대로 띠의 오른쪽 끝에 선다.
// 위 안쪽 여백만 `TRAY_TOP_EXTRA` 더 두꺼워서 띠가 위로만 자란다: 아래 끝과 그림의 자리는 그대로이고, 덮인 한 줄 말풍선의 윗변이 띠 위로 1~2pt 호로 남던 것(5478 계측: 띠 (8,376)-(196,429), 윗변 ≈ 375pt)을 덮는다.
//
// 누르면 **고르기만** 한다(호출한 쪽이 입력창 위 미리 보기에 올린다): 저절로 보내지 않는다. 글이 그 낱말뿐이면 호출한 쪽이 글을 지워 그림으로 바꾸고, 문구 안의 낱말이면 글을 두고
// 그림을 더한다(#5588, 코어 `isKeywordOnlyInput`). 그림은 이모티콘 창의 칸과 같은 정지 그림이다(`grid`: 움직이는 GIF 도 줄에서는 멈춘 그림이다).
// 닫는 길 둘 (#5602, planner 결정): ✕ 는 줄을 띄운 낱말 하나를 **이 대화에서 끈다**(M2). 「이번만 닫기」는 **줄을 아래로 쓸어내리기**다 — 다음 키워드까지 닫아 두고(웹 Esc 와 같다)
// 끄지는 않는다. 손가락을 따라 띠가 아래로 밀리고(`transform` 이라 자리를 먹지 않는다 - 도크·대화가 움직이지 않는다), 놓을 때 반 칸(`SWIPE_DISMISS_PT`) 넘게 내렸거나 빠르게 튕겼으면
// 닫고 아니면 제자리로 돌아온다(움직임 없이 한 번에). 가로로 먼저 움직인 손가락과 짧은 탭은 가져가지 않는다(그림 누르기·✕ 그대로). 낭독 사용자에게는 같은 일을 하는 접근성 동작 둘이 있다:
// 칸·✕ 의 동작 목록 「이번만 닫기」와, 줄 안 어디서든 두 손가락 Z(낭독의 「나가기」).
// 모양: 줄 반경 14 = 칸 반경 10 + 줄 안쪽 여백 4(중첩 반경, 위쪽만 더 두껍다). 칸은 눌림 면 44, ✕ 는 보이는 28 + 눌림 44. 서고 지는 움직임이 없어서 동작 줄이기와 무관하다(쓸어내리는 동안의 밀림은 손가락이
// 직접 끄는 것이다). 글자가 없어서 큰 글씨에서도 그대로다.
// =============================================================================

/** 칸의 시험 열쇠. 파생 열쇠는 JSX 밖에서 만든다: 직접 문구 장부는 JSX 표현식 안의 문자열 조각을 문구로 센다. */
const itemTestId = (name: string) => `composer-expression-suggest-item-${name}`;
/** ✕ 의 보이는 지름. 눌림 면은 `slopTo` 로 44까지 채운다. */
const MUTE_SIZE = 28;
/** 줄 안쪽 여백. 칸 반경(`ds2Radius.badge`)에 더하면 줄 반경(`ds2Radius.row`)이다. */
const TRAY_PAD = space.xs;
/** 위 안쪽 여백에만 더하는 몫: 띠가 위로만 자라서(아래 끝·그림 자리는 그대로) 덮인 한 줄 말풍선의 윗변이 띠 위로 비어져 나오지 않는다(#5492 M1). */
const TRAY_TOP_EXTRA = space.xs;

/** 쓸어내리기를 가져가기 시작하는 문턱(pt). 이보다 덜 움직인 손가락은 탭이거나 떨림이다(사진 뷰어 `CLAIM_SLOP_PT` 와 같은 값). */
export const SWIPE_CLAIM_PT = 8;
/** 놓을 때 이만큼(pt) **넘게** 내렸으면 닫는다: 칸 높이(눌림 면 44)의 반. 띠가 입력창 바로 위라 짧은 거리로 정한다. */
export const SWIPE_DISMISS_PT = TOUCH_TARGET / 2;
/** 놓는 순간 아래로 이 속도(pt/ms, `PanResponder` 의 `vy` 단위)를 **넘게** 움직였으면 거리와 무관하게 닫는다. 사진 뷰어의 700pt/s 와 같다. */
export const SWIPE_DISMISS_VELOCITY = 0.7;
/** 끄는 동안 띠가 밀려 내려가는 최대 거리(pt): 칸 높이 하나. 더 끌어도 입력창을 덮지 않는다. */
const SWIPE_TRAVEL_PT = TOUCH_TARGET;

/** 이 손가락을 쓸어내리기로 가져가는가: 아래로, 문턱을 넘게, 세로가 가로보다 크게. */
export function claimsSuggestSwipe(dx: number, dy: number): boolean {
  return dy > SWIPE_CLAIM_PT && dy > Math.abs(dx);
}

/** 놓을 때 닫는가: 반 칸 넘게 내렸거나 아래로 빠르게 튕겼다. */
export function dismissesSuggestSwipe(dy: number, vy: number): boolean {
  return dy > SWIPE_DISMISS_PT || vy > SWIPE_DISMISS_VELOCITY;
}

/** 칸·✕ 의 접근성 동작 이름(「이번만 닫기」). 이름은 코드의 값이고 읽히는 이름은 사전의 `expressions.suggest.dismiss` 다. */
const DISMISS_ACTION = 'momoSuggest:dismiss';

export function ComposerExpressionSuggest({
  items,
  onPick,
  onMute,
  onDismiss,
  marginHorizontal,
}: {
  items: readonly Expression[];
  /** 그림을 눌렀다. 보내지 않는다. */
  onPick: (item: Expression) => void;
  /** ✕: 줄을 띄운 낱말 하나의 추천을 이 대화에서 끈다(이름 「이 낱말 추천 끄기」와 같은 수, #5602 M2). */
  onMute: () => void;
  /** 「이번만 닫기」(쓸어내리기·접근성 동작): 줄을 닫고 다음 키워드까지 닫아 둔다. 끄지 않는다. */
  onDismiss: () => void;
  /** 알약이 화면 가장자리에서 뜬 거리. 줄의 양쪽 바깥 여백이 이 값이라 띠의 양끝이 알약의 양쪽 가장자리와 맞는다(알약 폭 전체). */
  marginHorizontal: number;
}) {
  const formatMessage = useExpressionMessages();
  const styles = useStyles(buildStyles);
  // 쓸어내리는 동안 띠가 손가락을 따라 내려가는 거리. `transform` 만 바꾼다 - 자리를 먹지 않아 도크·대화가 움직이지 않는다.
  const drag = useRef(new Animated.Value(0)).current;
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const swipe = useMemo(
    () =>
      PanResponder.create({
        // 캡처 단계에서 묻는다: 칸(`Pressable`)이 먼저 응답자가 되어도 아래로 끄는 손가락은 줄이 가져간다. 탭은 문턱 안이라 칸의 것이다.
        onMoveShouldSetPanResponderCapture: (_event, gesture) => claimsSuggestSwipe(gesture.dx, gesture.dy),
        onPanResponderTerminationRequest: () => false,
        onPanResponderMove: (_event, gesture) => drag.setValue(Math.min(Math.max(gesture.dy, 0), SWIPE_TRAVEL_PT)),
        onPanResponderRelease: (_event, gesture) => {
          drag.setValue(0);
          if (dismissesSuggestSwipe(gesture.dy, gesture.vy)) onDismissRef.current();
        },
        onPanResponderTerminate: () => drag.setValue(0),
      }),
    [drag],
  );
  const dismissActions = [{name: DISMISS_ACTION, label: formatMessage('expressions.suggest.dismiss')}];
  const onDismissAction = (event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName === DISMISS_ACTION) onDismiss();
  };
  return (
    <View style={styles.host} pointerEvents="box-none" testID="composer-expression-suggest-host">
      <Animated.View
        accessibilityRole="toolbar"
        accessibilityLabel={formatMessage('expressions.suggest.group')}
        onAccessibilityEscape={onDismiss}
        style={[styles.tray, {marginHorizontal, transform: [{translateY: drag}]}]}
        testID="composer-expression-suggest"
        {...swipe.panHandlers}>
        {items.map(item => (
          <Pressable
            key={item.id}
            accessibilityRole="button"
            accessibilityLabel={formatMessage('expressions.suggest.pick', {name: item.displayName})}
            accessibilityActions={dismissActions}
            onAccessibilityAction={onDismissAction}
            onPress={() => onPick(item)}
            style={({pressed}) => [styles.cell, pressed && styles.cellPressed]}
            testID={itemTestId(item.name)}>
            {/* 칸의 이름이 그림의 이름을 대신한다 - 그림 부품의 낭독 이름이 한 번 더 읽히지 않게 숨긴다. */}
            <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden pointerEvents="none">
              <ExpressionImage expression={item} size="grid" />
            </View>
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={formatMessage('expressions.suggest.mute')}
          accessibilityActions={dismissActions}
          onAccessibilityAction={onDismissAction}
          hitSlop={slopTo(MUTE_SIZE)}
          onPress={onMute}
          style={({pressed}) => [styles.mute, pressed && styles.cellPressed]}
          testID="composer-expression-suggest-mute">
          <Image source={CONV_ICONS.cross} style={styles.glyph} importantForAccessibility="no" />
        </Pressable>
      </Animated.View>
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    // 도크 밖으로 뜨는 칸: 멘션 목록과 같은 앵커(`bottom: 100%`)다. 알약과의 틈은 아래 `marginBottom`. 바깥 칸은 눌림을 받지 않고(`box-none`) 안쪽 줄만 받는다.
    host: {position: WORD.absolute, left: 0, right: 0, bottom: '100%', zIndex: 1, marginBottom: space.sm},
    // 폭을 가두지 않는다: `alignSelf`·`maxWidth`·`width` 가 없어서 바깥 칸(좌우 0)의 폭에서 양쪽 바깥 여백(JSX 의 `marginHorizontal`)을 뺀 만큼, 곧 알약의 폭 전체가 된다(#5492). 그림은 왼쪽부터, ✕ 는 오른쪽 끝(`mute` 의 `marginLeft`)이다.
    tray: {
      flexDirection: WORD.row,
      alignItems: WORD.center,
      gap: space.xs,
      padding: TRAY_PAD,
      paddingTop: TRAY_PAD + TRAY_TOP_EXTRA,
      borderRadius: ds2Radius.row,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
      backgroundColor: color.surface,
      boxShadow: color.elevationRest,
    },
    cell: {
      width: TOUCH_TARGET,
      height: TOUCH_TARGET,
      borderRadius: ds2Radius.badge,
      alignItems: WORD.center,
      justifyContent: WORD.center,
    },
    cellPressed: {backgroundColor: color.surfacePressed},
    mute: {
      width: MUTE_SIZE,
      height: MUTE_SIZE,
      borderRadius: MUTE_SIZE / 2,
      alignItems: WORD.center,
      justifyContent: WORD.center,
      marginLeft: WORD.auto,
      marginRight: space.xs,
    },
    glyph: {width: CONV_ICON_SIZE.cross, height: CONV_ICON_SIZE.cross, tintColor: color.icon},
  });
