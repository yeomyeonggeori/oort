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

// ---- 홈 아이콘 여섯 (DS2-3 #2715) --------------------------------------------
// 같은 시안의 `#hash`·`#lock`·`#dms`·`#more`·`#down`·`#bot`, 같은 레시피(선 1.8,
// viewBox 24). 크기는 시안이 그 아이콘을 쓰는 자리의 `.ic.s*`다.

export const HOME_ICONS = {
  hash: require('./hash.png') as ImageSourcePropType,
  lock: require('./lock.png') as ImageSourcePropType,
  dms: require('./dms.png') as ImageSourcePropType,
  more: require('./more.png') as ImageSourcePropType,
  down: require('./down.png') as ImageSourcePropType,
  bot: require('./bot.png') as ImageSourcePropType,
} as const;

export type HomeIconName = keyof typeof HOME_ICONS;

/**
 * 시안 `.a-sec-h .ic.s22`·`.a-row .ic.s22`(행·머리 22), `.ctl .ic`(20),
 * `.a-now .a-ag .ic.s18`(카드 18). 행 안 에이전트 사각의 글리프는 `.ic.s16`이라
 * 그 자리는 18 래스터를 16으로 줄여 그린다(`HOME.rowAgentGlyph`).
 */
export const HOME_ICON_SIZE: Readonly<Record<HomeIconName, number>> = {
  hash: 22,
  lock: 22,
  dms: 22,
  more: 20,
  down: 20,
  bot: 18,
};

// ---- 대화 아이콘 일곱 (DS2-4 #2716) ------------------------------------------
// 같은 레시피(선 1.8, viewBox 24, 1·2·3배). `left`·`up`·`check`·`file`·`plus`·`x`는
// 시안 `<symbol>`이고, `kebab`(세로 점 셋)은 시안에 없어 Lucide `ellipsis-vertical`
// 이다 — owner 피드백 표의 Buzz 머리 오른쪽 「⋮」. 이름이 셸의 `plus`·`x`와 겹치는
// 둘은 크기가 달라(20·14) 따로 굽는다.
//
// 허들 헤드폰은 **굽지 않았다**. 폰에는 허들이 없다(`realtime/channelRail.ts`가
// 허들 레일을 받지 않는다). 자리는 `ConversationHeader`의 `huddle` prop이 지고,
// 기능이 생기는 날 이 표에 한 줄이 는다.

export const CONV_ICONS = {
  left: require('./left.png') as ImageSourcePropType,
  kebab: require('./kebab.png') as ImageSourcePropType,
  plus: require('./plus20.png') as ImageSourcePropType,
  up: require('./up.png') as ImageSourcePropType,
  check: require('./check.png') as ImageSourcePropType,
  cross: require('./cross.png') as ImageSourcePropType,
  file: require('./file.png') as ImageSourcePropType,
} as const;

export type ConvIconName = keyof typeof CONV_ICONS;

/**
 * 시안 `.a-cbtn .ic.s22`(뒤로 22), `.ic`(⋮·+ 20), `.a-send .ic.s18`(↑ 18),
 * `.a-step .ic.s14`(단계 표지 14), `.a-file .ic.s18`(파일 타일 18).
 */
export const CONV_ICON_SIZE: Readonly<Record<ConvIconName, number>> = {
  left: 22,
  kebab: 20,
  plus: 20,
  up: 18,
  check: 14,
  cross: 14,
  file: 18,
};

// ---- + 메뉴 아이콘 넷 (DS2-2b #2750) -----------------------------------------
// 같은 시안의 `#dms`·`#hash`·`#bot`·`#activity`, 같은 레시피(선 1.8, viewBox 24),
// 22pt(Buzz 메뉴 아이콘 실측 ≈21). `dms`·`hash` 는 홈의 22 래스터를 그대로 쓰고,
// `bot` 은 홈의 18 래스터를 늘리면 흐려지므로 22 로 따로 굽는다(`bot22`).

export const MENU_ICONS = {
  dm: require('./dms.png') as ImageSourcePropType,
  channel: require('./hash.png') as ImageSourcePropType,
  agent: require('./bot22.png') as ImageSourcePropType,
  work: require('./activity.png') as ImageSourcePropType,
} as const;

export type MenuIconName = keyof typeof MENU_ICONS;

export const MENU_ICON_SIZE = 22;
