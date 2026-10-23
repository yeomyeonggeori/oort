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
// ## 왜 「이동할 때 가져오기」가 아니라 「닿을 때 쥐기」인가 — 시뮬레이터가 알려 준 것
//
// 첫 판은 `EdgeSwipeBack` 처럼 **이동 단계의 capture** 로 가져오게 짰다. 단위 시험은 초록이었고
// 시뮬레이터에서는 **한 번도 가져오지 못했다**: 터치 이동은 뿌리 뷰에 배달되는데(`onTouchMove`
// 가 울렸다) `onMoveShouldSetResponderCapture` 는 불리지 않았다.
//
// 원인은 React 트리다. 뷰어 Modal 은 `MessageRow` 의 **자손**으로 그려진다(`AttachmentList` →
// `AttachmentViewer`). 그래서 뷰어 안 빈 곳에 손가락이 닿으면 응답은 위로 번져 올라가
// **메시지 행의 `Pressable`** 이 쥔다. 이미 응답자가 있으면 이동 협상은 응답자와 대상의 공통
// 조상에서 **위쪽으로만** 걷는다 — 응답자의 자손인 뷰어 뿌리는 그 길에 없다. 뷰어가 응답을
// 한 번도 못 물어본 이유다.
//
// 그래서 닿는 순간(bubble 의 `onStartShouldSetResponder`)에 **뷰어가 먼저 쥔다.**
//   · 닫기·공유 단추는 뿌리보다 깊어서 bubble 에서 먼저 묻는다 — 자기 탭을 그대로 쥔다.
//   · 그 밖의 곳은 뿌리가 쥔다 — 메시지 행이 뷰어 안의 터치를 가져가지 못한다(탭이 행을
//     누르고, 길게 누르면 뒤에서 행 시트가 열리던 샘 하나가 이것으로 막힌다).
// 쥐는 것은 **판정이 아니다.** 아래로 갈 만큼 갔는지는 규칙이 이동에서 정한다.
//
// capture 단계(`onStartShouldSetResponderCapture`)는 걸지 않는다 — 걸면 그 아래 단추의 탭이 죽는다.
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
  panHandlers: GestureResponderHandlers;
}

export function useViewerDismiss({
  enabled,
  height,
  onDismiss,
  progressRef,
}: {
  /** 켜져 있는가. 확대 중이면 꺼야 한다(#4297). */
  enabled: boolean;
  /** 창 높이. 끄는 거리의 상한이다. */
  height: number;
  /** 놓았을 때 닫기로 판정되면 부른다. 뷰어를 걷어내는 쪽의 몫이다. */
  onDismiss: () => void;
  progressRef?: ViewerProgressRef;
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
  const stateRef = useRef<ViewerDragState>(IDLE);
  /** 마지막으로 쓴 거리. 놓은 순간 사람이 본 위치다. */
  const atRef = useRef(0);

  useEffect(() => () => drag.stopAnimation(), [drag]);

  const responder = useMemo(() => {
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
      // 닿는 순간 쥔다(bubble). 닫기·공유 단추는 더 깊어서 자기 탭을 먼저 쥔다.
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: event => {
        step('down', event);
      },
      // 응답을 쥔 채 둘째 손가락이 닿았다(핀치의 시작): 끌던 중이면 취소다.
      onPanResponderStart: event => {
        if (event.nativeEvent.touches.length > 1 && step('down', event).cancelled) {
          snapBack();
        }
      },
      onPanResponderMove: event => {
        const result = step('move', event);
        if (result.cancelled) {
          snapBack();
          return;
        }
        if (result.claims) write(result.offset);
      },
      // 끌기를 가져가기 전에는 양보한다(가로 넘김·가장자리 뒤로가기), 가져간 뒤에는 거절한다.
      onPanResponderTerminationRequest: () => !stateRef.current.claimed,
      onPanResponderRelease: (_event, gesture) => {
        const claimed = stateRef.current.claimed;
        stateRef.current = IDLE;
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
        if (claimed) snapBack();
      },
    });
  }, [drag, reduceMotion]);

  return {drag, panHandlers: responder.panHandlers};
}
