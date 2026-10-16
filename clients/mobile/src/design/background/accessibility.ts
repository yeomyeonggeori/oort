import {useEffect, useState} from 'react';
import {AccessibilityInfo} from 'react-native';

// =============================================================================
// 배경을 끄는 두 시스템 설정 (ADR-0189 증보 2 · 본문 D7 정신).
//
// iOS 「투명도 줄이기」와 「대비 높이기」(RN 의 `darkerSystemColors`)가 켜지면 사용자의
// 배경은 **무조건** 꺼지고 불투명 기본 바닥이 선다. 사용자가 시스템을 이길 수 없다 —
// 이 두 설정을 켠 사람이 그것을 필요로 하는 이유가 바로 배경 위의 글자이기 때문이다.
//
// 구독은 프로바이더 하나다(`theme.tsx` 머리 주석의 「구독은 앱 전체에 하나」). 첫 답이
// 오기 전에는 둘 다 `false` 다: 한 틱 동안 배경이었다가 꺼지는 편이, 모르는 동안 모두의
// 배경을 끄는 것보다 덜 틀린다.
// =============================================================================

export function useBackgroundA11yFlags(): {reduceTransparency: boolean; increaseContrast: boolean} {
  const [reduceTransparency, setReduce] = useState(false);
  const [increaseContrast, setDarker] = useState(false);
  useEffect(() => {
    let alive = true;
    const ask = (
      fn: () => Promise<boolean>,
      set: (value: boolean) => void,
    ) => {
      try {
        fn().then(
          value => {
            if (alive) set(value);
          },
          () => {
            /* 모름은 false 로 남는다 */
          },
        );
      } catch {
        /* 같은 이유 */
      }
    };
    ask(() => AccessibilityInfo.isReduceTransparencyEnabled(), setReduce);
    ask(() => AccessibilityInfo.isDarkerSystemColorsEnabled(), setDarker);
    const subscriptions = [
      AccessibilityInfo.addEventListener('reduceTransparencyChanged', setReduce),
      AccessibilityInfo.addEventListener('darkerSystemColorsChanged', setDarker),
    ];
    return () => {
      alive = false;
      for (const subscription of subscriptions) subscription?.remove();
    };
  }, []);
  return {reduceTransparency, increaseContrast};
}
