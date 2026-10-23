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
  followY,
  IDLE,
  settles,
  viewerDragStep,
  type ViewerDragInput,
  type ViewerDragState,
} from './viewerDismiss';

// =============================================================================
// 사진 뷰어의 쓸어 닫기 — 규칙(`viewerDismiss.ts`)을 `PanResponder` 에 묶는다 (#4293).
//
// 이 훅이 하는 일은 셋이다. ① 손가락이 가져갈 만큼 움직였는지 규칙에 묻고 ② 가져갔으면
// 끄는 거리를 `drag` 한 값에 쓰고(사진의 위치·배경의 옅음·단추 띠의 옅음·크기가 전부 이
// 값에서 파생한다) ③ 놓았을 때 규칙이 `dismiss` 라고 하면 `onDismiss` 를 부른다.
//
// ## 왜 capture 단계인가
//
// 가로 페이지 넘김의 `ScrollView` 가 같은 손가락을 두고 다투기 때문이다. bubble 단계에 두면
// 이미 responder 를 쥔 스크롤뷰에게 밀린다(`EdgeSwipeBack` 의 같은 설명). 다만 이 쪽은
// **세로가 앞설 때만** 가져가므로(`viewerDragStep`) 가로로 넘기는 손가락은 건드리지 않는다.
// 시작에서는 절대 가져가지 않는다 — 가져가면 위쪽 단추의 탭이 전부 죽는다.
//
// ## 시작점에서 잰다
//
// `gestureState.dy` 가 아니라 터치를 **처음 댄 점**의 page 좌표에서 잰다. `PanResponder` 는
// 가져온 순간 `dy` 를 0 으로 되돌리므로, 가져오기까지 손가락이 이미 간 문턱(8pt)이 사라지고
// 사진이 손가락보다 그만큼 뒤에서 따라온다. 그것은 「따라온다」가 아니라 「끌려온다」다.
//
// ## 닫는 것은 호출부의 일이다
//
// 놓은 뒤의 사라짐은 Modal 이 한다(시스템 페이드 — 끌던 자리에서 그대로 옅어진다). 이
// 훅은 사진을 미끄러뜨려 내보내지 않는다. 그래서 「동작 줄이기」에서 달라지는 것은 **모자라
// 놓았을 때의 복귀**뿐이다: 스프링 대신 즉시 제자리다.
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

  const responder = useMemo(
    () => {
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

      const input = (
        kind: ViewerDragInput['kind'],
        event: GestureResponderEvent,
      ): ViewerDragInput => ({
        kind,
        touches: event.nativeEvent.touches?.length ?? 1,
        point: {x: event.nativeEvent.pageX, y: event.nativeEvent.pageY},
      });

      const step = (kind: ViewerDragInput['kind'], event: GestureResponderEvent) => {
        const result = viewerDragStep(
          stateRef.current,
          input(kind, event),
          {enabled: enabledRef.current},
          heightRef.current,
        );
        stateRef.current = result.state;
        return result;
      };

      return PanResponder.create({
        // 시작점만 적는다. **언제나 false** — 여기서 가져가면 위쪽 단추의 탭이 죽는다.
        // 둘째 손가락이 닿을 때도 이 핸들러가 불린다(공통 조상이라) — 끌던 중이면 취소다.
        onStartShouldSetPanResponderCapture: event => {
          if (step('down', event).cancelled) snapBack();
          return false;
        },
        onMoveShouldSetPanResponderCapture: event => step('move', event).claims,
        onPanResponderGrant: event => {
          // 가져온 순간 손가락은 이미 문턱만큼 가 있다 — 거기서부터 그린다.
          const origin = stateRef.current.origin;
          if (origin === null) return;
          write(followY(event.nativeEvent.pageY - origin.y, heightRef.current));
        },
        onPanResponderMove: event => {
          const result = step('move', event);
          if (result.cancelled) {
            snapBack();
            return;
          }
          if (result.claims) write(result.offset);
        },
        // 잡았으면 놓지 않는다. 여기서 양보하면 밑의 스크롤뷰가 도중에 되가져간다.
        onPanResponderTerminationRequest: () => false,
        onPanResponderRelease: (_event, gesture) => {
          const claimed = stateRef.current.claimed;
          stateRef.current = IDLE;
          if (!claimed) return; // 둘째 손가락으로 이미 취소됐다
          if (settles({offset: atRef.current, velocityPtPerMs: gesture.vy}) === 'dismiss') {
            onDismissRef.current();
            return;
          }
          snapBack();
        },
        // 빼앗겼다(전화가 왔거나 OS 가 제스처를 취소했다). 사람이 놓은 것이 아니므로 닫지 않는다.
        onPanResponderTerminate: () => {
          const claimed = stateRef.current.claimed;
          stateRef.current = IDLE;
          if (claimed) snapBack();
        },
        // iOS 의 UIScrollView 에게 팬을 취소하라고 말하는 것이 이 한 줄이다.
        onShouldBlockNativeResponder: () => true,
      });
    },
    [drag, reduceMotion],
  );

  return {drag, panHandlers: responder.panHandlers};
}
