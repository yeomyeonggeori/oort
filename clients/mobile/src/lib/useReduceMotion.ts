import {useEffect, useRef, useState, type MutableRefObject} from 'react';
import {AccessibilityInfo} from 'react-native';

/**
 * iOS 「동작 줄이기」가 켜져 있는가 (#1892), **읽을 때의 값**으로.
 *
 * 웹 타임라인은 점프 스크롤을 `prefers-reduced-motion` 에 따라 즉시/부드럽게
 * 가른다(`timelineScrollBehavior`). 폰의 같은 자리는 이 값을 본다. 설정은 앱이
 * 떠 있는 동안에도 바뀌므로 구독한다.
 *
 * 상태가 아니라 ref 인 이유 (design-review 2594 R1 N-1): 이 값을 읽는 곳은 점프를
 * **누르는 순간**뿐이고, 값이 바뀌어도 다시 그릴 것이 없다. 첫 판은 상태였고, 첫
 * 답이 비동기로 도착할 때마다 목록 전체를 한 번 다시 그렸다 — 테스트에서는 그것이
 * act 밖의 갱신 경고로 드러났고, 그 소음이 진짜 act 경고를 가렸다.
 *
 * 처음 답이 오기 전에는 `false` 다 — 모르는 동안 움직임을 빼는 것보다, 한 번의
 * 점프가 부드럽게 도는 쪽이 덜 놀랍다. 답은 한 틱 안에 온다.
 */
export function useReduceMotionRef(): MutableRefObject<boolean> {
  const reduce = useRef(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then(
      value => {
        if (alive) reduce.current = value;
      },
      () => {
        /* unknown stays false */
      },
    );
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      value => {
        reduce.current = value;
      },
    );
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);
  return reduce;
}

/**
 * 「동작 줄이기」를 **상태로** (DS2-3 #2715). 계속 도는 움직임(홈 카드의 「작업 중」
 * 맥박)은 설정이 바뀌는 순간 멈추거나 다시 돌아야 하므로 ref 가 아니라 다시 그리는
 * 값이어야 한다 — `useReduceTransparency` 와 같은 이유다.
 *
 * 첫 답이 오기 전에는 `true` 다. 위의 ref 판과 반대인 이유: 저것은 한 번의 점프이고,
 * 이것은 끝없이 반복되는 움직임이다. 모르는 한 틱 동안 멈춰 있는 것은 아무도 해치지
 * 않지만, 동작을 줄여 달라고 한 사람에게 한 틱이라도 맥박을 보이는 것은 해친다.
 */
export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(true);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then(
      value => {
        if (alive) setReduce(value);
      },
      () => {
        /* 모름은 true 로 남는다 */
      },
    );
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      value => setReduce(value),
    );
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);
  return reduce;
}
