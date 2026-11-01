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
  // 상대를 알아볼 수 없는 DM(「나간 멤버」)의 기본 아바타 글리프 (#4252). 웹 `DmAvatar` 의 Lucide `user`
  // (16)와 같은 모양이고 같은 레시피(선 1.8, viewBox 24, 18pt 의 1·2·3배)다.
  user: require('./user18.png') as ImageSourcePropType,
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
  user: 18,
};

// ---- 대화 아이콘 여덟 (DS2-4 #2716 · 시계 #4455) -----------------------------
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
  // 오래 걸리는 전송의 표지 (#4455). Lucide `clock`(ISC) — 같은 레시피(선 1.8, viewBox 24, 12pt 의
  // 1·2·3배). 시각 글자(`font.meta` 12)와 같은 크기라 이름 줄 옆에서 글자보다 튀지 않는다.
  clock: require('./clock.png') as ImageSourcePropType,
  // 스레드 머리의 「따라가기」 단추(#4890). Lucide `bell`·`bell-off`(ISC, 웹이 `lucide-react` 0.454.0 으로 쓰는 같은 집합 — 경로 그대로)를
  // 같은 레시피(선 1.8, viewBox 24, `rsvg-convert`, 20pt 의 1·2·3배)로 **옮겨 담았다**. 새로 그린 것이 아니다. 켜짐은 `bell`,
  // 꺼짐은 빗금이 있는 `bell-off`.
  bell: require('./bell.png') as ImageSourcePropType,
  bellOff: require('./bell-off.png') as ImageSourcePropType,
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
  clock: 12,
  bell: 20,
  bellOff: 20,
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

// ---- AI 연결 제안 아이콘 둘 (#2948 GC-7) --------------------------------------
// 시안 `claudedocs/chat-genui-connect/mockups.html`의 `#i-plug`(한 줄 머리)·
// `#i-laptop`(「맥에서 해요」 줄), 같은 레시피(선 1.8, viewBox 24, 1·2·3배), 14pt
// (시안 `.oneline .ic`·`.pnote .ic` 14px).
export const AI_CONNECT_ICONS = {
  plug: require('./plug.png') as ImageSourcePropType,
  laptop: require('./laptop.png') as ImageSourcePropType,
} as const;

export const AI_CONNECT_ICON_SIZE = 14;

// ---- 첨부 메뉴 아이콘 셋 (#4180) ----------------------------------------------
// Lucide `camera`·`image`·`file`(ISC, 웹이 `lucide-react`로 쓰는 같은 집합 — 웹 0.454.0의
// 경로 그대로), 같은 레시피(선 1.8, viewBox 24, 1·2·3배). 22pt(`MENU_ICON_SIZE`)는 + 메뉴 아이콘과 같은 크기다 —
// Buzz 글리프(≈15pt)보다 20~40% 크지만 한글 라벨(22pt)과의 비율을 맞춘 의도한 차이다(design-review 2차).
// 다시 만드는 법: `rsvg-convert -w <22|44|66> -h <22|44|66>` 로 위 레시피의 SVG를 래스터.
export const ATTACH_MENU_ICONS = {
  camera: require('./camera22.png') as ImageSourcePropType,
  photo: require('./image22.png') as ImageSourcePropType,
  file: require('./file22.png') as ImageSourcePropType,
} as const;

export type AttachMenuIconName = keyof typeof ATTACH_MENU_ICONS;

// ---- 시트·페이지 머리와 행 아이콘 넷 (#4318) ----------------------------------
// 같은 레시피(viewBox 24, round, 1·2·3배)이고 경로의 출처도 Lucide(ISC)다. 머리 단추의 닫기·확정
// (`x22`·`check22`)은 Buzz 실측에 맞춰 선을 2.0 으로 한 단 굵게 굽고, 복사·셰브론은 1.8 이다. 14pt
// 로 구운 `check`(대화 단계 표지)를 키우면 흐려지므로(위 `bot22` 사례) 22pt 로 따로 굽는다.

export const SHEET_ICONS = {
  close: require('./x22.png') as ImageSourcePropType,
  check: require('./check22.png') as ImageSourcePropType,
  copy: require('./copy22.png') as ImageSourcePropType,
  chevron: require('./chevron18.png') as ImageSourcePropType,
} as const;

export type SheetIconName = keyof typeof SHEET_ICONS;

/** 머리 단추 글리프(닫기·확정) 22 — Buzz 22, 행 오른쪽 복사 22, 셰브론 18. */
export const SHEET_ICON_SIZE: Readonly<Record<SheetIconName, number>> = {
  close: 22,
  check: 22,
  copy: 22,
  chevron: 18,
};

// ---- 사진 뷰어 아이콘 둘 (#4297) ---------------------------------------------
// Lucide `download`·`share`(ISC, 웹이 `lucide-react` 로 쓰는 같은 집합 — 경로 그대로), 같은 레시피(선 1.8, viewBox 24,
// 22pt 의 1·2·3배). 뷰어 맨 아래 둥근 유리 [저장]·[공유] 안에 선다. 「share」는 iOS 의 공유 글리프(네모 + 위 화살표)와
// 같은 뜻이라 시스템 공유 시트가 뜬다는 예고가 된다. 다시 만드는 법: `rsvg-convert -w <22|44|66> -h <22|44|66>`.

export const VIEWER_ICONS = {
  download: require('./download22.png') as ImageSourcePropType,
  share: require('./share22.png') as ImageSourcePropType,
} as const;

export type ViewerIconName = keyof typeof VIEWER_ICONS;

/** 둥근 유리 단추 안 글리프 22 — 뒤로(`CONV_ICON_SIZE.left`)와 같은 크기라 세 단추의 글리프가 한 무게로 읽힌다. */
export const VIEWER_ICON_SIZE = 22;

// ---- 링크 카드의 지구 (#4883) -------------------------------------------------
// Lucide `globe`(ISC, 웹이 `lucide-react` 로 쓰는 같은 집합 — 경로 그대로), 같은 레시피(선 1.8, viewBox 24,
// 24pt 의 1·2·3배). 서버가 사이트 아이콘을 주지 못한 카드의 **기본 아이콘**이다(코어 `unfurlCardModel`:
// `iconUrl` 이 없으면 지구). 주소 줄에서는 16으로, 그림 칸의 타일에서는 24로 그린다(큰 래스터를 줄여 그린다).
// 다시 만드는 법: `rsvg-convert -w <24|48|72> -h <24|48|72>`, 경로는
// `<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>`.

export const LINK_CARD_ICONS = {
  globe: require('./globe24.png') as ImageSourcePropType,
} as const;
