import {createContext, useContext} from 'react';
import type {Animated} from 'react-native';

// =============================================================================
// 변신 틀의 오른쪽 가장자리 — 카드 안 「오른쪽에 닻이 있는 컨트롤」이 틀을 따라간다 (#4181, design-review).
//
// 카드 층은 카드 폭으로 고정이고 바닥·왼쪽에 닻이 있다. 틀은 그 위를 `overflow: hidden` 으로 열어 가므로
// 오른쪽 가장자리에서 12pt 안쪽에 있는 알약(「전체 사진」·「N장 첨부」)은 틀이 충분히 넓어지는 마지막 구간까지
// **불투명한 채 낱말 중간에서 잘렸다**(열 때마다, 접을 때마다). 왼쪽 아래 뒤로 원은 틀 모서리에 붙어 따라오는데
// 알약만 카드 크기에 붙어 있었다. 틀이 알려 주는 가로 이동(`≤ 0`pt)을 알약에 걸면 알약이 언제나 틀의 오른쪽 가장자리에서
// 같은 거리에 선다 — 이동 = `메뉴 폭 − 카드 폭` × (1 − 진행). 진행 1(카드)에서는 0 이다.
//
// 틀 밖(하네스·시험이 카드를 따로 세울 때)에서는 값이 0 이라 아무 일도 없다.
// =============================================================================

export type MorphEdgeShift = Animated.AnimatedInterpolation<number> | number;

export const MorphEdgeContext = createContext<MorphEdgeShift>(0);

/** 지금 틀이 오른쪽 가장자리를 카드 폭보다 얼마나 덜 열었는가(음수 pt, 다 열렸으면 0). */
export function useMorphEdgeShift(): MorphEdgeShift {
  return useContext(MorphEdgeContext);
}
