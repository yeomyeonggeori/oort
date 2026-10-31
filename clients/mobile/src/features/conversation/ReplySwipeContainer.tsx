import React, {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import {Animated, Image, PanResponder, StyleSheet, View} from 'react-native';

import {CONV_ICON_SIZE, CONV_ICONS} from '../../design/icons';
import {useStyles, usePalette} from '../../design/theme';
import {radius, space, type Palette} from '../../design/tokens';
import {haptics} from '../../lib/haptics';
import {CONV} from './convDesign';
import {ReduceMotionRefContext} from './LandedTintFade';
import {
  IDLE,
  REPLY_COMMIT_PX,
  isReplyArmed,
  replySwipeOffset,
  replySwipeStep,
  type ReplySwipeState,
} from './replySwipe';

// =============================================================================
// 행 바깥의 밀기 컨테이너 — 오른쪽→왼쪽으로 밀면 그 자리에서 스레드 답글 (#4869).
//
// 규칙은 `replySwipe.ts` 가 든다(문턱·방향·잠금과 그 근거). 이 파일은 그것을 `PanResponder`·`Animated`·햅틱에 묶는
// 배선이고, 새 네이티브 의존(gesture-handler·reanimated)은 없다 — RN 기본 응답자만 쓴다.
//
// ## 응답자를 **시작에서 잡지 않는다** (#4645)
//
// `onStartShouldSetPanResponderCapture` 는 시작점만 적고 **언제나 false** 다. 시작에서 잡는 것은 `onStartShouldSet…` 도
// 쓰지 않는다. iOS(Fabric)는 JS 응답자가 된 터치의 네이티브 스크롤을 막으므로, 행이 시작에서 잡으면 목록 위에서 시작한
// 세로 스크롤이 죽는다. 이동이 오른쪽→왼쪽으로 뚜렷이 우세할 때(`onMoveShouldSetPanResponderCapture`) **한 번만** 잡는다.
// capture 길인 이유: 행 안의 `Pressable`(본문·링크·사진·칩)이 이미 응답자이므로, 그 눌림을 취소하고 가져오려면 응답자
// 플러그인이 조상에게 묻는 이동 질문의 capture 길에서 답해야 한다(시트의 끌어 닫기가 같은 길이다, `PageSheet`).
//
// 잡은 뒤에는 놓지 않는다(`onPanResponderTerminationRequest: () => false`). 그래도 네이티브 스크롤이 시작되면 iOS 가 터치를
// 취소하므로(`onShouldBlockNativeResponder` 는 iOS 에서 버려진다) `onPanResponderTerminate` 가 와서 **답글 없이** 제자리로
// 돌아간다. 이 경합은 실기에서만 보인다 — 인계의 「스택 검증 메모」에 손으로 볼 장면을 적었다(`runtime-unverified`).
//
// ## 길게 누르기와 겹치지 않는다
//
// 가져가는 문턱(12pt)이 길게 누르기 허용치(10pt) 위라서, 가져간 손가락은 이미 길게 누르기가 아니다. 반대로 길게 눌러 시트가
// 열린 손가락이 그 뒤에 움직여도 밀지 않는다: `ReplySwipeGuardContext` 의 표지(행이 시트를 열 때 세운다)를 새 터치 시작에서
// 거둔다.
//
// ## 상시 노드를 지지 않는다
//
// 이 컨테이너는 타임라인의 **모든 행**에 서 있다. 아이콘 자리(뷰 셋과 그림 둘)는 끌기가 **시작될 때만** 마운트하고(`dragging`) 놓거나
// 빼앗기면 걷는다 — 행마다 상시 노드를 다섯 개씩 지면 빠르게 스크롤하며 행이 마운트되는 비용에 그대로 얹힌다. 상태는 이 컴포넌트
// 안에서만 바뀌고 `children` 은 같은 엘리먼트라 행은 다시 그려지지 않는다.
//
// ## 「동작 줄이기」
//
// 손가락을 따라가는 움직임(직접 조작)은 그대로고, **장식**만 끈다: 놓았을 때 미끄러져 돌아오지 않고 바로 서며, 아이콘은
// 커지며 나타나지 않고 문턱에서 켜진다. 설정은 목록이 한 번 들고 행들이 읽는다(`ReduceMotionRefContext`) — 행마다
// `AccessibilityInfo` 를 묻지 않는다.
// =============================================================================

/**
 * 행이 길게 눌러 시트를 열었다는 표지. `true` 인 터치는 밀지 않는다. 새 터치가 시작될 때 컨테이너가 거둔다.
 * 컨텍스트가 없는 표면(검색 미리보기·측정 하네스)에서는 `null` 이고 표지가 없다.
 */
export const ReplySwipeGuardContext =
  createContext<MutableRefObject<boolean> | null>(null);

/** 아이콘이 처음 나타날 때의 크기 비율 — 문턱에서 1 이 된다. */
const GLYPH_SCALE_FROM = 0.6;

export function ReplySwipeContainer({
  enabled,
  onCommit,
  offsetRef,
  children,
}: {
  /** 이 행을 밀 수 있는가. 아니면 어떤 이동도 잡지 않는다. */
  enabled: boolean;
  /** 문턱을 넘겨 놓았다. 답글 입력칸을 여는 것은 호출한 쪽의 몫이다. */
  onCommit: () => void;
  /** 테스트가 행의 위치를 읽는 이음매(앱은 주지 않는다). 왼쪽이 양수, 놓은 뒤에는 0 이다. */
  offsetRef?: MutableRefObject<number | null>;
  children: React.ReactNode;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const reduceMotionContext = useContext(ReduceMotionRefContext);

  // 응답자는 **한 번만** 만든다. 이 컴포넌트는 타임라인의 모든 행이라 핸들러 신원이 렌더마다 바뀌면 그 churn 이 가장 비싼
  // 자리다(`useLongPress`·`EdgeSwipeBack` 이 같은 이유로 같은 선택을 했다). 핸들러는 최신 값을 ref 로 읽는다.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const reduceMotionRef = useRef(reduceMotionContext);
  reduceMotionRef.current = reduceMotionContext;
  const offsetSeam = useRef(offsetRef);
  offsetSeam.current = offsetRef;

  const guard = useRef(false);
  const stateRef = useRef<ReplySwipeState>(IDLE);
  /** 끌기를 쥐고 있는가 — 아이콘 자리는 그동안만 선다. */
  const [dragging, setDragging] = useState(false);
  /** 이 제스처에서 햅틱을 이미 냈는가 — 문턱을 **처음** 지날 때 한 번만 울린다. */
  const firedRef = useRef(false);

  /** 행이 가 있는 곳(왼쪽이 음수). 아이콘·행이 같은 값 하나를 읽는다. */
  const x = useRef(new Animated.Value(0)).current;
  /** 아이콘의 나타남(0~1)·크기 비율·문턱에서 켜지는 채움. 움직임을 줄였을 때 손가락 이벤트가 바로 정하므로 값을 직접 쓴다. */
  const glyphOpacity = useRef(new Animated.Value(0)).current;
  const glyphScale = useRef(new Animated.Value(GLYPH_SCALE_FROM)).current;
  const armedFill = useRef(new Animated.Value(0)).current;

  const responder = useMemo(() => {
    const reduced = () => reduceMotionRef.current?.current === true;

    const draw = (dx: number) => {
      const offset = replySwipeOffset(dx);
      const armed = isReplyArmed(dx);
      const reach = Math.min(1, offset / REPLY_COMMIT_PX);
      x.setValue(-offset);
      if (reduced()) {
        // 장식을 끈다: 아이콘은 크기 변화 없이 문턱에서 켜진다.
        glyphOpacity.setValue(armed ? 1 : 0);
        glyphScale.setValue(1);
      } else {
        glyphOpacity.setValue(reach);
        glyphScale.setValue(GLYPH_SCALE_FROM + (1 - GLYPH_SCALE_FROM) * reach);
      }
      armedFill.setValue(armed ? 1 : 0);
      if (offsetSeam.current) offsetSeam.current.current = offset;
      // 문턱을 **처음** 지나는 순간 한 번. 되돌아갔다 다시 지나도 이 제스처에서는 다시 울리지 않는다(연속 햅틱 피로).
      if (armed && !firedRef.current) {
        firedRef.current = true;
        haptics.event('replySwipeThreshold');
      }
    };

    // 놓았거나 빼앗겼다: 제자리로. 동작 줄이기면 미끄러지지 않고 바로 선다.
    const settle = () => {
      setDragging(false);
      glyphOpacity.setValue(0);
      glyphScale.setValue(GLYPH_SCALE_FROM);
      armedFill.setValue(0);
      if (offsetSeam.current) offsetSeam.current.current = 0;
      if (reduced()) {
        x.setValue(0);
        return;
      }
      Animated.spring(x, {toValue: 0, useNativeDriver: true, bounciness: 0}).start();
    };

    return PanResponder.create({
      // 시작점만 적는다. **언제나 false** — 위 머리말의 단 하나의 약속.
      onStartShouldSetPanResponderCapture: event => {
        const {pageX, pageY, touches} = event.nativeEvent;
        // 새 첫 터치다: 길게 누르기가 앞 터치에 세운 표지와 앞 제스처의 햅틱 표지를 거둔다.
        if ((touches?.length ?? 1) <= 1) {
          guard.current = false;
          firedRef.current = false;
        }
        stateRef.current = replySwipeStep(
          stateRef.current,
          {kind: 'down', touches: touches?.length ?? 1, point: {x: pageX, y: pageY}},
          {enabled: enabledRef.current},
        ).state;
        return false;
      },
      onMoveShouldSetPanResponderCapture: (event, gesture) => {
        // 길게 눌러 시트가 열린 손가락은 시트의 것이다.
        if (guard.current) return false;
        const {pageX, pageY} = event.nativeEvent;
        const {state, claims} = replySwipeStep(
          stateRef.current,
          {kind: 'move', touches: gesture.numberActiveTouches, point: {x: pageX, y: pageY}},
          {enabled: enabledRef.current},
        );
        stateRef.current = state;
        return claims;
      },
      // 가져온 순간 손가락은 이미 문턱만큼 가 있다. **거기서부터** 그린다(가장자리 뒤로가기와 같은 선택).
      onPanResponderGrant: event => {
        const origin = stateRef.current.origin;
        if (origin === null) return;
        setDragging(true);
        draw(event.nativeEvent.pageX - origin.x);
      },
      onPanResponderMove: event => {
        const origin = stateRef.current.origin;
        if (origin === null) return;
        draw(event.nativeEvent.pageX - origin.x);
      },
      // 잡았으면 놓지 않는다. 네이티브 스크롤이 터치를 거두는 것은 이 값과 무관하게 `Terminate` 로 온다.
      onPanResponderTerminationRequest: () => false,
      onPanResponderRelease: event => {
        const origin = stateRef.current.origin;
        stateRef.current = IDLE;
        const commit =
          origin !== null &&
          !guard.current &&
          isReplyArmed(event.nativeEvent.pageX - origin.x);
        settle();
        // 문턱 전에 놓으면 아무 일도 없다. 제자리로 돌아가는 것이 전부다.
        if (commit) onCommitRef.current();
      },
      // 빼앗겼다(스크롤이 시작됐거나 OS 가 제스처를 취소했다). 사람이 놓은 것이 아니므로 답글을 열지 않는다.
      onPanResponderTerminate: () => {
        stateRef.current = IDLE;
        settle();
      },
    });
  }, [armedFill, glyphOpacity, glyphScale, x]);

  return (
    <ReplySwipeGuardContext.Provider value={guard}>
      <View testID="reply-swipe" {...responder.panHandlers}>
        {dragging ? (
          // 행 뒤, 오른쪽 가장자리에서 드러나는 자리. 눌리지도 읽히지도 않는다(VoiceOver 의 길은 행동 시트의 「답글 달기」다).
          <View
            style={styles.slot}
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants">
            <Animated.View
              style={[
                styles.glyph,
                {opacity: glyphOpacity, transform: [{scale: glyphScale}]},
              ]}
              testID="reply-swipe-glyph">
              <Image
                source={CONV_ICONS.reply}
                style={[styles.icon, {tintColor: palette.textMuted}]}
              />
              <Animated.View
                style={[styles.armed, {opacity: armedFill}]}
                testID="reply-swipe-glyph-armed">
                <Image
                  source={CONV_ICONS.reply}
                  style={[styles.icon, {tintColor: palette.onAccent}]}
                />
              </Animated.View>
            </Animated.View>
          </View>
        ) : null}
        <Animated.View style={{transform: [{translateX: x}]}}>
          {children}
        </Animated.View>
      </View>
    </ReplySwipeGuardContext.Provider>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    slot: {
      ...StyleSheet.absoluteFill,
      justifyContent: 'center',
      alignItems: 'flex-end',
      // 드러나는 띠(문턱 64) 안에 원(입력창의 + · 보내기 원과 같은 지름)이 들어앉는다.
      paddingRight: space.lg,
    },
    glyph: {
      width: CONV.composerCircle,
      height: CONV.composerCircle,
      borderRadius: radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: color.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
    },
    armed: {
      ...StyleSheet.absoluteFill,
      borderRadius: radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: color.accent,
    },
    icon: {
      width: CONV_ICON_SIZE.reply,
      height: CONV_ICON_SIZE.reply,
    },
  });
