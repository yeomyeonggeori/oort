import {SHEET, type Palette} from './tokens';

// =============================================================================
// 시트의 규칙 — **판정만**. 배선은 `PageSheet.tsx`·`sheetParts.tsx` 다 (#4318).
//
// `nav/edgeSwipe.ts` 와 같은 이유로 갈라 둔다: 규칙이 터치 핸들러와 Animated 값에 붙어 있으면
// 시험이 재생할 수 없고, 재생할 수 없는 방어는 죽어도 아무도 모른다. 끌어 닫기의 문턱이 한 번
// 조용히 바뀌어도(`>` 가 `>=` 가 되거나 값이 두 배가 되어도) 아래 단정이 빨개진다.
// =============================================================================

/** 시안 `.a-sheet{top:58px}` — 상태 막대 바로 아래. 큰 단의 위 끝이다. */
export const SHEET_TOP = 58;

/** 이만큼(pt) 끌어내리면 놓는 순간 닫는다. 손잡이 높이의 배수가 아니라 「절반쯤 내렸다」의 체감값. */
export const SHEET_DISMISS_DISTANCE = 120;

/** 이 속도(pt/ms)보다 빠르게 튕기면 거리가 모자라도 닫는다. */
export const SHEET_DISMISS_VELOCITY = 1.1;

/**
 * 손을 뗐을 때 시트를 닫는가. 거리와 속도 **어느 한쪽**이면 닫고, 둘 다 모자라면 제자리로 돌아온다.
 * 경계값 자체(120.0 · 1.1)는 닫지 않는다 — 「넘어야」 닫는다.
 */
export function shouldDismissSheet(dy: number, vy: number): boolean {
  return dy > SHEET_DISMISS_DISTANCE || vy > SHEET_DISMISS_VELOCITY;
}

/** 내용 맞춤 · 중간 · 큰. 시트가 얼마나 화면을 차지하는가. */
export type SheetHeight = 'fit' | 'medium' | 'large';

/** 시트 상자의 세로 배치. 아래는 화면 바닥에 붙고, 키보드가 올라와 있으면 키보드 윗면에 붙는다. */
export interface SheetFrame {
  /** 큰 단: 위 끝 고정. */
  top?: number;
  /** 중간 단: 높이 고정(목록이 걸러져도 시트가 뛰지 않는다). */
  height?: number;
  /** 내용 맞춤 단: 내용 높이, 이 위로는 안에서 스크롤. */
  maxHeight?: number;
  /** 키보드가 올라와 있을 때만 있다: 시트의 바닥이 화면 바닥에서 이만큼(= 키보드 높이) 떠 있다. */
  bottom?: number;
}

/**
 * 큰 단이 시작하는 위 끝(화면 위에서 pt). 상태 막대가 58보다 깊은 기기(다이내믹 아일랜드)에서는 그
 * 아래 4pt — 58 은 시안 기기(상태 막대 54)의 값이라 그 위에 올리면 시계와 겹친다. 키보드로 올라온
 * 시트도 이 선을 넘지 않는다(머리의 X 가 시계 뒤로 들어가면 닫을 수 없다).
 */
export function sheetTop(insetTop: number): number {
  return Math.max(SHEET_TOP, insetTop + 4);
}

/**
 * 단계별 상자.
 *
 *   large   위 58 에서 바닥까지.
 *   medium  화면의 9/16(Buzz). 고정 높이.
 *   fit     내용 높이, 화면의 85% 위로는 안에서 스크롤. 배경 탭으로 닫는 길이 그 나머지로 남는다.
 *
 * ## 키보드 (`keyboardHeight` > 0)
 *
 * 시트의 **바닥이 키보드 윗면에 앉는다**(`bottom` = 키보드 높이). 그러면 시트 안의 입력 칸은 시트
 * 바닥보다 아래일 수 없으니 키보드 위에 있다. 시트가 위로 자라지는 못하게 막는다: 중간·내용 맞춤은
 * 높이(최대 높이)를 「키보드 위 ~ 큰 단의 위 끝」 사이(`room`)로 줄이고(SE 에서는 9/16 = 375 에
 * 키보드 ~300 이 더해지면 667 을 넘는다), 큰 단은 위 끝이 고정이라 바닥만 올라가 줄어든다. 키보드가
 * 없으면(0) 옛 상자 그대로다 — `bottom` 은 아예 없고, 그릇의 `bottom: 0` 이 그 자리를 지킨다.
 */
export function sheetFrame(
  height: SheetHeight,
  windowHeight: number,
  insetTop: number,
  keyboardHeight = 0,
): SheetFrame {
  const top = sheetTop(insetTop);
  const lift = keyboardHeight > 0 ? {bottom: keyboardHeight} : {};
  const room = Math.max(0, windowHeight - keyboardHeight - top);
  switch (height) {
    case 'large':
      return {top, ...lift};
    case 'medium':
      return {
        height: Math.min(Math.floor(windowHeight * SHEET.mediumRatio), room),
        ...lift,
      };
    case 'fit':
      return {
        maxHeight: Math.min(Math.floor(windowHeight * SHEET.fitMaxRatio), room),
        ...lift,
      };
  }
}

/** 카드 안의 앞 칸: 없음 · 아이콘 칸(22) · 그보다 넓은 앞 요소(아바타)의 폭. */
export type CardInset = 'plain' | 'icon' | number;

/**
 * 구분선이 카드 왼쪽에서 얼마나 들어가 시작하는가. 앞 칸이 있는 카드는 그 칸을 비켜 글자 열에
 * 맞추고(Buzz `AppListCard._dividerIndent`), 없는 카드는 카드 안쪽 여백에 맞춘다.
 */
export function dividerIndent(inset: CardInset): number {
  if (inset === 'plain') return SHEET.cardInset;
  const lead = inset === 'icon' ? SHEET.iconSlot : inset;
  return SHEET.cardInset + lead + SHEET.iconGap;
}

/** 목록의 한 줄이 묶음 카드에서 어디에 서는가 — 바깥 모서리와 구분선이 이것으로 갈린다. */
export type CardPosition = 'only' | 'first' | 'middle' | 'last';

export function cardPosition(index: number, count: number): CardPosition {
  if (count <= 1) return 'only';
  if (index <= 0) return 'first';
  if (index >= count - 1) return 'last';
  return 'middle';
}

/**
 * 원형 단추의 채움과 가장자리 — 「떠 있다」는 것의 토큰 근거.
 *
 * 라이트의 원은 `surface` 가 바탕 `sheet` 위에 서고 `elevationRest` 그림자가 띄운다. 다크에서는
 * 그림자가 보이지 않는다(`tokens.ts` `DARK_ELEVATION` 주석: 따뜻한 그림자는 어두운 바닥 위에서
 * 사라진다). 게다가 다크의 `surface` 는 `sheet` 와 새벽하늘 1.076 · 흑연 1.035 로 **라이트의
 * 1.109 · 1.083 보다 덜 갈린다**. 그래서 다크는 한 단 위 `surfaceMuted`(1.234 · 1.119)로 채우고
 * 윗면의 가장자리 한 줄(`glassLine`)을 더한다. 관계(다크의 원이 라이트의 원보다 바탕에서 덜
 * 구분되지 않는다)는 값이 아니라 시험이 모든 테마에서 잰다(`sheetKit.test.tsx`).
 */
export function circleLook(color: Palette): {fill: string; ring: string} {
  return color.mode === 'dark'
    ? {fill: color.surfaceMuted, ring: color.glassLine}
    : {fill: color.surface, ring: 'transparent'};
}

/** 묶음 카드의 가장자리. 라이트는 채움 차이로 충분하고, 다크는 그림자가 없으니 가는 선(`border`)이 가른다. */
export function cardRing(color: Palette): string {
  return color.mode === 'dark' ? color.border : 'transparent';
}
