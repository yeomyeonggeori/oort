import type {ImageSourcePropType} from 'react-native';

// =============================================================================
// AI 연결 카드의 글리프 넷 (#2945 GC-4).
//
// 경로는 시안 `claudedocs/chat-genui-connect/mockups.html`의 `#i-plug`·`#i-eye`·
// `#i-laptop`·`#i-refresh`이고, 출처는 셸 아이콘과 같은 Lucide(ISC) 계열이다. 폰에는
// SVG 렌더러가 없으므로(ADR-0137 D1) `index.ts`와 같은 방식으로 1·2·3배 PNG를 두고
// `tintColor`로 칠한다.
//
// 다시 만드는 법(rsvg-convert): viewBox `0 0 24 24`, `stroke-width="1.8"`,
// `stroke-linecap/linejoin="round"`, 16pt 1·2·3배.
//
// `index.ts`에 줄을 더하지 않고 파일을 따로 둔 이유: 제안 카드(GC-7 #2948)가 같은
// 글리프를 쓰면서 셸 아이콘 표를 함께 고치지 않게 하려는 것이다.
// =============================================================================

export const CARD_ICONS = {
  plug: require('./card-plug.png') as ImageSourcePropType,
  eye: require('./card-eye.png') as ImageSourcePropType,
  laptop: require('./card-laptop.png') as ImageSourcePropType,
  refresh: require('./card-refresh.png') as ImageSourcePropType,
} as const;

export type CardIconName = keyof typeof CARD_ICONS;
