import {act, screen} from '@testing-library/react-native';
import {type NativeTouchEvent} from 'react-native';

// =============================================================================
// 가장자리 밀기 시험이 쓰는 손가락 하나 — `edgeSwipeBack.test.tsx` 에서 옮겨 온 그대로다(#4457: 층의 퇴장 중에는
// 가장자리가 다시 잡히지 않는다는 시험이 같은 손가락을 쓴다). 동작은 바꾸지 않았다.
// =============================================================================

// -----------------------------------------------------------------------------
// 손가락 하나. React Native 의 responder 시스템이 뷰에게 하는 호출을 그대로 한다.
//
// `fireEvent` 가 아니라 prop 을 직접 부르는 이유: 이 제스처의 판정은 **capture 단계**에
// 있고(그래야 밑의 스크롤뷰보다 먼저 질문을 받는다), 그 단계는 테스트 라이브러리의
// 이벤트 이름으로는 정확히 재현되지 않는다. `PanResponder` 는 `event.touchHistory` 로
// 자기 상태를 갱신하므로 그것도 진짜 모양으로 만들어 준다.
// -----------------------------------------------------------------------------
interface Sample {
  x: number;
  y: number;
  t: number;
}

export function finger(target: {props: Record<string, (event: unknown) => unknown>}) {
  let start: Sample = {x: 0, y: 0, t: 0};
  let previous: Sample = start;
  let current: Sample = start;
  let clock = 1_000;
  let active = true;
  let granted = false;

  function event() {
    const touch = {
      identifier: 0,
      target: 1,
      pageX: current.x,
      pageY: current.y,
      locationX: current.x,
      locationY: current.y,
      timestamp: current.t,
    } as unknown as NativeTouchEvent;
    return {
      nativeEvent: {
        ...touch,
        touches: active ? [touch] : [],
        changedTouches: [touch],
        timestamp: current.t,
      },
      touchHistory: {
        touchBank: [
          {
            touchActive: active,
            startPageX: start.x,
            startPageY: start.y,
            startTimeStamp: start.t,
            currentPageX: current.x,
            currentPageY: current.y,
            currentTimeStamp: current.t,
            previousPageX: previous.x,
            previousPageY: previous.y,
            previousTimeStamp: previous.t,
          },
        ],
        numberActiveTouches: active ? 1 : 0,
        indexOfSingleActiveTouch: 0,
        mostRecentTimeStamp: current.t,
      },
    };
  }

  return {
    /** 화면에 손가락이 닿았다. */
    down(x: number, y: number) {
      clock += 16;
      start = {x, y, t: clock};
      previous = start;
      current = start;
      active = true;
      granted = false;
      act(() => {
        target.props.onStartShouldSetResponderCapture?.(event());
      });
    },
    /** 손가락이 움직였다. 가져갔으면 true. */
    move(x: number, y: number, dt = 16): boolean {
      clock += dt;
      previous = current;
      current = {x, y, t: clock};
      let claimed = false;
      act(() => {
        if (!granted) {
          claimed = Boolean(
            target.props.onMoveShouldSetResponderCapture?.(event()),
          );
          if (claimed) {
            granted = true;
            target.props.onResponderGrant?.(event());
          }
        } else {
          target.props.onResponderMove?.(event());
        }
      });
      return claimed;
    },
    /** 손가락을 뗐다. */
    up() {
      active = false;
      act(() => {
        target.props.onResponderRelease?.(event());
      });
    },
    get granted() {
      return granted;
    },
  };
}

export function pane(testID = 'edge-swipe-pane') {
  return screen.getByTestId(testID) as unknown as {
    props: Record<string, (event: unknown) => unknown>;
  };
}
