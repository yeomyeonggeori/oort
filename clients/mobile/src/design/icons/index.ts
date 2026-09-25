import type {ImageSourcePropType} from 'react-native';

// =============================================================================
// 셸 아이콘 네 개 — 시안 A의 `<symbol>`을 그대로 래스터로 옮긴 것 (DS2-2 #2714).
//
// 경로는 시안 `claudedocs/design-2.0/mockups.html`의 `#home`·`#inbox`·`#search`·
// `#plus`·`#x`이고, 그 경로의 출처는 Lucide(ISC, 웹이 `lucide-react`로 이미 쓰는 같은
// 집합)다. 폰에는 SVG 렌더러가 없다(`react-native-svg`는 새 네이티브 의존이라
// ADR 사항이다, ADR-0137 D1). 그래서 시안과 같은 선 굵기(1.8, viewBox 24)로
// 1x·2x·3x PNG를 만들어 두고 `tintColor`로 칠한다 — 모양은 시안, 색은 팔레트다.
//
// 다시 만드는 법(rsvg-convert): viewBox `0 0 24 24`, `stroke-width="1.8"`,
// `stroke-linecap/linejoin="round"`, 탭 아이콘 24pt · FAB 26pt · 시트 닫기 20pt, 각 1·2·3배.
// =============================================================================

export const SHELL_ICONS = {
  home: require('./home.png') as ImageSourcePropType,
  inbox: require('./inbox.png') as ImageSourcePropType,
  search: require('./search.png') as ImageSourcePropType,
  plus: require('./plus.png') as ImageSourcePropType,
  x: require('./x.png') as ImageSourcePropType,
} as const;

export type ShellIconName = keyof typeof SHELL_ICONS;

/** 시안 `.ic.s24`(탭)와 `.ic.s26`(FAB). */
export const SHELL_ICON_SIZE: Readonly<Record<ShellIconName, number>> = {
  home: 24,
  inbox: 24,
  search: 24,
  plus: 26,
  /** 시안 `.a-cbtn` 안의 `.ic`(20). */
  x: 20,
};
