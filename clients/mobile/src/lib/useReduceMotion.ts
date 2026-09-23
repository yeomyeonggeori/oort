import {useEffect, useRef, type MutableRefObject} from 'react';
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
