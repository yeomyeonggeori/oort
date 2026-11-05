import type {ImageSourcePropType} from 'react-native';

// 검색 탭만 쓰는 아이콘. Lucide `clock`(ISC, 웹이 `lucide-react` 0.454.0 으로 쓰는 같은 집합 — 경로 그대로: circle r10 + polyline `12 6 12 12 16 14`)을
// 셸 아이콘과 같은 레시피(선 1.8, viewBox 24, round)로 20pt 의 1·2·3배로 **옮겨 담았다**(`rsvg-convert -w <20|40|60> -h <20|40|60>`). 새로 그린 모양이
// 아니다. 대화 아이콘의 `clock`(12pt)은 시각 글자 옆 표지라 키우면 흐려져서 따로 굽는다.
export const SEARCH_ICONS = {
  clock: require('../../design/icons/clock20.png') as ImageSourcePropType,
} as const;

export const SEARCH_CLOCK_SIZE = 20;
