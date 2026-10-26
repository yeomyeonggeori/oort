import {act} from '@testing-library/react-native';
import {AccessibilityInfo} from 'react-native';

import {retainReduceMotion} from '../../src/lib/useReduceMotion';

/**
 * 시험이 시스템의 「동작 줄이기」 답을 **정해 두는** 이음매 (#4457).
 *
 * 움직임이 주제가 아닌 시험(설정 페이지의 행·시트·상태)은 층이 누르는 즉시 걷히기를 바란다. 층의 퇴장 모션은
 * 타이머를 끼우므로, 이 시험들은 동작 줄이기를 켠 채 돈다 — 「켜면 즉시 걷힌다」가 이 약속의 정의이기도 하다.
 * 움직임 자체를 재는 시험(`layerMotion.test.tsx`)은 이것을 `false` 로 부른다.
 *
 * 앱의 뿌리가 시작 때 하는 일(`App.tsx`)을 그대로 한다: 저장소를 붙들어 답을 **층이 서기 전에** 알게 한다. 그러지
 * 않으면 첫 렌더가 기본값(꺼짐)으로 올라온다. 돌려주는 함수가 저장소를 놓는다(`afterEach` 에서 부른다).
 */
export async function pinReduceMotion(value: boolean): Promise<() => void> {
  (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockImplementation(() =>
    Promise.resolve(value),
  );
  const release = retainReduceMotion();
  await act(async () => {});
  return release;
}
