import {useEffect, useMemo, useRef, type MutableRefObject} from 'react';
import {
  Animated,
  PanResponder,
  type GestureResponderEvent,
  type GestureResponderHandlers,
} from 'react-native';
import {VIEWER_SNAP_SPRING} from '../../design/motion';
import {useReduceMotionRef} from '../../lib/useReduceMotion';
import {
  IDLE,
  settles,
  viewerDragStep,
  type ViewerDragInput,
  type ViewerDragState,
} from './viewerDismiss';

// =============================================================================
// 사진 뷰어의 쓸어 닫기 — 규칙(`viewerDismiss.ts`)을 `PanResponder` 에 묶는다 (#4293).
//
// 이 훅이 하는 일은 셋이다. ① 손가락이 닿으면 응답을 쥐고 ② 아래로 가져갈 만큼 움직였는지
// 규칙에 물어 가져갔으면 끄는 거리를 `drag` 한 값에 쓰고(사진의 위치·배경의 옅음·단추 띠의
// 옅음·크기가 전부 이 값에서 파생한다) ③ 놓았을 때 규칙이 `dismiss` 라고 하면 `onDismiss` 를
// 부른다.
//
// ## 어디서 쥐는가 — 시뮬레이터가 두 번 알려 준 것
//
// ### ① 왜 「이동할 때 가져오기」가 아니라 「닿을 때 쥐기」인가
//
// 첫 판은 `EdgeSwipeBack` 처럼 **이동 단계의 capture** 로 가져오게 짰다. 단위 시험은 초록이었고
// 시뮬레이터에서는 **한 번도 가져오지 못했다**: 터치 이동은 뿌리 뷰에 배달되는데(`onTouchMove`
// 가 울렸다) `onMoveShouldSetResponderCapture` 는 불리지 않았다.
//
// 원인은 React 트리다. 뷰어 Modal 은 `MessageRow` 의 **자손**으로 그려진다(`AttachmentList` →
// `AttachmentViewer`). 그래서 뷰어 안 빈 곳에 손가락이 닿으면 응답은 위로 번져 올라가
// **메시지 행의 `Pressable`** 이 쥔다. 이미 응답자가 있으면 이동 협상은 응답자와 대상의 공통
// 조상에서 **위쪽으로만** 걷는다 — 응답자의 자손인 뷰어 뿌리는 그 길에 없다. 뷰어가 응답을
// 한 번도 못 물어본 이유다. 그래서 닿는 순간(bubble 의 `onStartShouldSetResponder`)에 뷰어가
// 먼저 쥔다. 쥐는 것은 **판정이 아니다.** 아래로 갈 만큼 갔는지는 규칙이 이동에서 정한다.
//
// ### ② 어디서 쥐는가 — 뿌리가 아니라 **쪽**이다 (design-review r2 B-1)
//
// 둘째 판은 뿌리 View 가 쥐었다. 그러자 **옆으로 넘기기가 죽었다**: 뿌리는 가로 `ScrollView` 의
// **조상**이고, iOS(Fabric) 의 ScrollView 는 자기 superview 사슬 중 하나라도 JS 응답자이면
// 스크롤을 시작하지 못한다(`RCTScrollViewComponentView._shouldDisableScrollInteraction` →
// `touchesShouldCancelInContentView:`). 「가로 `ScrollView` 가 스크롤을 시작하면 응답을 달라고
// 한다 → 양보」는 스크롤이 시작돼야 열리는 길이라 **한 번도 불리지 않았다.** jest 에는 네이티브
// 스크롤뷰가 없어서 그 길을 손으로 짠 터치 열로만 재고 있었고, 그래서 초록이었다.
//
// 그래서 쥐는 자리는 **쪽**(`pageHandlers`, `ViewerPage` 의 View)이다. 쪽은 ScrollView 의 **자손**이라
// 조상으로 스크롤을 막지 않는다 — 스크롤뷰 안의 `Pressable` 과 같은 모양이다. 옆으로 넘기면 스크롤뷰가
// 스크롤을 시작하고(`scrollShouldSetResponder`) 응답을 달라고 하며, 쪽은 아직 끌기를 가져가지 않았으니
// 내준다.
//
// 뿌리(`frameHandlers`)는 **사진 밖**(단추 띠의 빈 곳·홈 인디케이터 인셋)에 닿은 손가락만 쥔다. 거기서
// 시작한 손가락은 스크롤뷰의 것이 아니라서 막을 스크롤이 없고, 메시지 행이 그 터치를 가져가지도 못한다
// (탭이 행을 누르고, 길게 누르면 뒤에서 행 시트가 열리던 샘 하나가 이것으로 막힌다). 사진 위의 손가락은
// 더 깊은 쪽이 먼저 쥐므로 뿌리는 묻지도 않는다. 닫기·공유 단추도 쪽·뿌리보다 깊어서 자기 탭을 그대로 쥔다.
//
// capture 단계(`onStartShouldSetResponderCapture`)는 걸지 않는다 — 걸면 그 아래 단추의 탭이 죽는다.
//
// ### ③ 뿌리가 받는 것은 부분 집합이다
//
// 한 `PanResponder` 의 핸들러를 조상(뿌리)과 자손(쪽)에 **같이 펼치면 안 된다.** 응답자가 쪽이면 응답
// 시스템은 이동마다 쪽의 **조상**에게 `onMoveShouldSetResponder(Capture)` 를 묻는데, PanResponder 는
// 그 물음에서 공유 `gestureState` 를 먼저 갱신하고(`_accountsForMovesUpTo`) 같은 이동의
// `onResponderMove` 를 「이미 처리함」으로 건너뛴다 — 끌기가 한 걸음도 안 간다. 그래서 뿌리에는 이동
// should-set 둘을 뺀 나머지만 준다.
//
// ### ④ 둘째 손가락은 쥐지 않는다
//
// 닿는 순간 쥐는 것은 **첫** 손가락뿐이다. 쪽이 쥔 채 둘째 손가락이 닿으면 응답 시스템은 쪽의 조상(뿌리)에게도
// `onStartShouldSetResponder` 를 묻는데, 거기서 참을 주면 응답이 쪽에서 뿌리(= 스크롤뷰의 조상)로 옮겨 가
// 넘기던 스크롤이 도중에 멈춘다.
//
// ### ⑤ 끌기를 쥐면 가로 스크롤을 잠근다 (대각선 끌기)
//
// 쪽이 끌기를 쥔 뒤에도 가로 `ScrollView` 의 네이티브 팬은 살아 있다. 손가락이 대각선으로 내려가면 사진이 내려가는
// 동안 스크롤뷰도 같은 손가락의 가로 성분을 따라 스크롤해 **옆 장이 끌려 들어온다**(시뮬레이터 대각선 끌기에서
// 본 것 — `directionalLockEnabled` 는 이 경우를 막지 못했다). 그래서 끌기를 쥐는 순간 호출부에 알려
// (`onDraggingChange`) 스크롤뷰의 `scrollEnabled` 를 끄고, 끌기가 끝나면(놓음·빼앗김·취소) 켠다.
//
// ## 양보는 쥐기 전까지다
//
// `onPanResponderTerminationRequest` 는 **끌기를 가져가기 전에는 양보하고, 가져간 뒤에는 거절한다.**
//   · 가로 페이지 넘김: 가로 `ScrollView` 가 스크롤을 시작하면 응답을 달라고 한다 → 양보.
//   · 좌측 가장자리 쓸기 뒤로가기(`EdgeSwipeBack`, 앱 루트의 capture): 응답을 달라고 한다 →
//     양보. 이 제스처는 뷰어 안에서도 그대로 산다(이슈: 「돌아가기 제스처는 그대로 둬요」).
//   · 끌기를 가져간 뒤: 거절. 밑의 스크롤뷰가 도중에 되가져가면 사진이 손가락을 놓친다.
//
// ## 시작점에서 잰다
//
// `gestureState.dy` 가 아니라 터치를 **처음 댄 점**의 page 좌표에서 잰다. 첫 걸음이 문턱(8pt)을
// 넘어서야 가져가므로 `dy` 를 쓰면 그만큼이 사라지고 사진이 손가락보다 뒤에서 따라온다. 그것은
// 「따라온다」가 아니라 「끌려온다」다.
//
// ## 닫는 것은 호출부의 일이다
//
// 놓은 뒤의 사라짐은 Modal 이 한다(시스템 페이드 — 끌던 자리에서 그대로 옅어진다). 이 훅은 사진을
// 미끄러뜨려 내보내지 않는다. 그래서 「동작 줄이기」에서 달라지는 것은 **모자라 놓았을 때의
// 복귀**뿐이다: 스프링 대신 즉시 제자리다.
// =============================================================================

/** 시험이 끄는 거리를 읽는 이음매. `EdgeSwipeBack` 의 `progressRef` 와 같은 성격. */
export type ViewerProgressRef = MutableRefObject<number | null>;

export interface ViewerDismiss {
  /** 끄는 거리(pt). 0 이상. 모든 모양이 이 한 값에서 `interpolate` 로 파생한다. */
  drag: Animated.Value;
  /**
   * **쪽**(가로 `ScrollView` 의 **자손**)에 펼친다 — 사진 위에 닿은 손가락을 쥐는 자리다. 뿌리에
   * 펼치면 안 된다: 조상이 JS 응답자이면 iOS 스크롤뷰는 스크롤을 시작하지 못한다(위 ②).
   */
  pageHandlers: GestureResponderHandlers;
  /**
   * 뿌리에 펼친다 — 사진 **밖**(단추 띠의 빈 곳·인셋)에 닿은 손가락만 쥔다. 이동 should-set 둘을
   * 뺀 부분 집합이다(위 ③). 쪽과 같은 규칙 상태를 공유한다.
   */
  frameHandlers: GestureResponderHandlers;
}

/**
 * 뿌리에 주지 않는 핸들러. 응답자가 쪽일 때 응답 시스템이 쪽의 조상(뿌리)에게 이동마다 묻는 둘이고,
 * `PanResponder` 는 이 물음에서 공유 `gestureState` 를 먼저 갱신해 같은 이동의 `onResponderMove` 를
 * 건너뛰게 만든다(위 ③).
 */
const FRAME_OMITTED = [
  'onMoveShouldSetResponder',
  'onMoveShouldSetResponderCapture',
] as const;

export function useViewerDismiss({
  enabled,
  height,
  onDismiss,
  progressRef,
  onDraggingChange,
}: {
  /** 켜져 있는가. 확대 중이면 꺼야 한다(#4297). */
  enabled: boolean;
  /** 창 높이. 끄는 거리의 상한이다. */
  height: number;
  /** 놓았을 때 닫기로 판정되면 부른다. 뷰어를 걷어내는 쪽의 몫이다. */
  onDismiss: () => void;
  progressRef?: ViewerProgressRef;
  /**
   * 끌기를 **쥔 순간** 참, 끌기가 **끝난 순간**(놓음·빼앗김·취소) 거짓으로 알린다. 호출부는 그동안 가로 스크롤을
   * 잠근다(위 ⑤). 바뀔 때만 부른다.
   */
  onDraggingChange?: (dragging: boolean) => void;
}): ViewerDismiss {
  const drag = useRef(new Animated.Value(0)).current;
  const reduceMotion = useReduceMotionRef();

  // PanResponder 는 한 번만 만든다. 핸들러가 읽는 값은 전부 ref 로 둔다(`EdgeSwipeBack` 과 같은 이유).
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const heightRef = useRef(height);
  heightRef.current = height;
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const progressRefRef = useRef(progressRef);
  progressRefRef.current = progressRef;
  const onDraggingChangeRef = useRef(onDraggingChange);
  onDraggingChangeRef.current = onDraggingChange;
  /** 지금 알려 둔 끌기 상태. 바뀔 때만 호출부에 알린다. */
  const draggingRef = useRef(false);
  const stateRef = useRef<ViewerDragState>(IDLE);
  /** 마지막으로 쓴 거리. 놓은 순간 사람이 본 위치다. */
  const atRef = useRef(0);

  useEffect(() => () => drag.stopAnimation(), [drag]);

  const responder = useMemo(() => {
    const setDragging = (value: boolean) => {
      if (draggingRef.current === value) return;
      draggingRef.current = value;
      onDraggingChangeRef.current?.(value);
    };

    const write = (value: number) => {
      atRef.current = value;
      drag.setValue(value); // 돌고 있던 복귀 스프링도 멈춘다 — 다시 잡을 수 있다.
      if (progressRefRef.current) progressRefRef.current.current = value;
    };

    const snapBack = () => {
      atRef.current = 0;
      if (progressRefRef.current) progressRefRef.current.current = 0;
      if (reduceMotion.current) {
        drag.setValue(0);
        return;
      }
      Animated.spring(drag, {
        toValue: 0,
        ...VIEWER_SNAP_SPRING,
        overshootClamping: true,
        useNativeDriver: true,
      }).start();
    };

    const step = (kind: ViewerDragInput['kind'], event: GestureResponderEvent) => {
      const result = viewerDragStep(
        stateRef.current,
        {
          kind,
          touches: event.nativeEvent.touches?.length ?? 1,
          point: {x: event.nativeEvent.pageX, y: event.nativeEvent.pageY},
        },
        {enabled: enabledRef.current},
        heightRef.current,
      );
      stateRef.current = result.state;
      return result;
    };

    return PanResponder.create({
      // 닿는 순간 **첫 손가락**을 쥔다(bubble). 닫기·공유 단추는 더 깊어서 자기 탭을 먼저 쥔다.
      // 둘째 손가락은 쥐지 않는다 — 쪽이 쥔 채 둘째 손가락이 닿을 때 뿌리가 응답을 가져가면 응답이
      // 스크롤뷰의 조상으로 옮겨 가 넘기던 스크롤이 멈춘다(위 ④).
      onStartShouldSetPanResponder: event =>
        (event.nativeEvent.touches?.length ?? 1) <= 1,
      onPanResponderGrant: event => {
        step('down', event);
      },
      // 응답을 쥔 채 둘째 손가락이 닿았다(핀치의 시작): 끌던 중이면 취소다.
      onPanResponderStart: event => {
        if (event.nativeEvent.touches.length > 1 && step('down', event).cancelled) {
          setDragging(false);
          snapBack();
        }
      },
      onPanResponderMove: event => {
        const result = step('move', event);
        if (result.cancelled) {
          setDragging(false);
          snapBack();
          return;
        }
        if (result.claims) {
          setDragging(true);
          write(result.offset);
        }
      },
      // 끌기를 가져가기 전에는 양보한다(가로 넘김·가장자리 뒤로가기), 가져간 뒤에는 거절한다.
      onPanResponderTerminationRequest: () => !stateRef.current.claimed,
      onPanResponderRelease: (_event, gesture) => {
        const claimed = stateRef.current.claimed;
        stateRef.current = IDLE;
        setDragging(false);
        if (!claimed) return; // 탭이거나, 가로·위로 간 손가락이거나, 둘째 손가락으로 이미 취소됐다
        if (settles({offset: atRef.current, velocityPtPerMs: gesture.vy}) === 'dismiss') {
          onDismissRef.current();
          return;
        }
        snapBack();
      },
      // 빼앗겼다(스크롤뷰·가장자리 뒤로가기·전화·OS 취소). 사람이 놓은 것이 아니므로 닫지 않는다.
      onPanResponderTerminate: () => {
        const claimed = stateRef.current.claimed;
        stateRef.current = IDLE;
        setDragging(false);
        if (claimed) snapBack();
      },
    });
  }, [drag, reduceMotion]);

  // 뿌리는 이동 should-set 둘을 뺀 부분 집합만 받는다(위 ③). 같은 함수·같은 상태를 가리킨다.
  const frameHandlers = useMemo(() => {
    const subset: GestureResponderHandlers = {...responder.panHandlers};
    for (const name of FRAME_OMITTED) delete subset[name];
    return subset;
  }, [responder]);

  return {drag, pageHandlers: responder.panHandlers, frameHandlers};
}
