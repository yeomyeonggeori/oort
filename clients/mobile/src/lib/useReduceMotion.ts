import {useEffect, useState} from 'react';
import {AccessibilityInfo} from 'react-native';

/**
 * iOS 「동작 줄이기」가 켜져 있는가 (#1892).
 *
 * 웹 타임라인은 점프 스크롤을 `prefers-reduced-motion` 에 따라 즉시/부드럽게
 * 가른다(`timelineScrollBehavior`). 폰의 같은 자리는 이 값을 본다. 설정은 앱이
 * 떠 있는 동안에도 바뀌므로 구독한다.
 *
 * 처음 답이 오기 전에는 `false` 다 — 모르는 동안 움직임을 빼는 것보다, 한 번의
 * 점프가 부드럽게 도는 쪽이 덜 놀랍다. 답은 한 틱 안에 온다.
 */
export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then(
      value => {
        if (alive) setReduce(value);
      },
      () => {
        /* unknown stays false */
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
