import {BAR_CONTROL_MAX_SCALE, STACK_PILL_SCALE} from '../../design/atoms';
import {estimateTextWidth, textEm} from '../../design/textEstimate';
import {font} from '../../design/tokens';
import {CONV} from './convDesign';

// =============================================================================
// 대화 머리 가운데 알약 — 무엇이 어디에 얼마나 서는가 (#4319, owner 10-27 「Buzz 처럼 가운데 이름 + 상태」).
//
// 머리는 **한 줄**이다(#4016, owner 「두 줄로 표시하니까 좀 구리네」) — 이름과 보조 글(DM 의 상태 낱말·채널의 멤버 수)이 알약 안에 나란히
// 서고, 줄이 모자라면 **이름이 이긴다**: 이름은 말줄임으로라도 읽혀야 하는 것이고 보조 글은 없어도 정보 페이지가 다 말한다. 그래서 보조 글은
// 줄어들지 않고 **통째로 숨는다**(잘린 보조 글은 거짓말이다 — 「응…」).
//
// Jest 에는 레이아웃 엔진이 없어 「이름이 몇 글자 남는가」를 잴 수 없다. 규칙을 **순수 함수**로 빼서(글자 폭은 `design/textEstimate.ts` 의 넉넉한
// 어림) 값으로 시험한다. 실제 폭이 어림보다 좁으면 이름이 `flexShrink` 로 줄어 말줄임이 되고(보조 글은 `flexShrink: 0`), 그것이 마지막 안전망이다.
// =============================================================================

/** 이름이 먼저 보장받는 폭 — 한글 몇 글자(제목 글꼴 기준). 이름이 이보다 짧으면 이름 전체가 바닥이다. */
export const PILL_NAME_FLOOR_CHARS = 5;

/** DM 상태 낱말로 눈에 보일 수 있는 최대 폭(em). 넘으면(「깨웠지만 아직 안 가져감」) 눈에서는 빠지고 낭독·정보 페이지가 전문을 말한다. */
export const PILL_STATUS_WORD_MAX_EM = 8;

/**
 * 양쪽 칸의 폭 — 둘이 **같아서** 가운데 알약이 정말 가운데에 선다. 오른쪽에 든 원(허들 자리·⋮)의 수로 정하고, 왼쪽(뒤로)은 같은 폭을 비워 둔다.
 * 오른쪽이 비어도(⋮ 가 없다) 원 하나 폭을 지킨다 — 알약이 한쪽으로 쏠리지 않게.
 */
export function headerSlotWidth({huddle, menu}: {huddle: boolean; menu: boolean}): number {
  const circles = Math.max(1, (huddle ? 1 : 0) + (menu ? 1 : 0));
  return circles * CONV.circle + (circles - 1) * CONV.headGap;
}

/** 알약이 쓸 수 있는 가로(pt) — 창 폭에서 머리의 좌우 여백·양쪽 칸·칸 사이 간격을 뺀 것. */
export function pillContainerWidth(windowWidth: number, slotWidth: number): number {
  return windowWidth - 2 * CONV.headPadX - 2 * slotWidth - 2 * CONV.headGap;
}

/**
 * DM 상태 낱말의 **눈에 보이는** 형태. 코어의 상태 문장은 긴 판정이다(「조용함 · 마지막 응답 5분 전」·「살아 있음 · 대기 중」) — 알약에는
 * ` · ` 앞의 낱말만 서고, 그래도 길면(`PILL_STATUS_WORD_MAX_EM`) 서지 않는다. 낭독 이름과 정보 페이지의 칩은 전문 그대로다.
 */
export function pillStatusWord(label: string | undefined): string | null {
  if (label === undefined) return null;
  const word = label.split(' · ')[0].trim();
  if (word === '' || textEm(word) > PILL_STATUS_WORD_MAX_EM) return null;
  return word;
}

/**
 * 보조 글을 알약에 세우는가. 둘 중 하나라도 어긋나면 숨긴다:
 *   1. 큰 글씨(`STACK_PILL_SCALE` 부터) — 이름이 먼저 자란다.
 *   2. 보조 글을 세우고 남는 폭이 **이름의 바닥**(`PILL_NAME_FLOOR_CHARS` 글자, 이름이 더 짧으면 이름 전체)에 못 미친다.
 */
export function pillShowsSecondary({
  name,
  secondary,
  leading,
  windowWidth,
  fontScale,
  slotWidth,
}: {
  name: string;
  secondary: string;
  /** 이름 앞에 서는 것의 폭(DM 얼굴 28·채널 `#` 16). */
  leading: number;
  windowWidth: number;
  fontScale: number;
  slotWidth: number;
}): boolean {
  if (secondary === '' || fontScale >= STACK_PILL_SCALE) return false;
  // 머리 글자는 `BAR_CONTROL_MAX_SCALE` 에서 멈춘다 — 더 큰 배율의 폭을 어리면 늘 숨겨 버린다.
  const scale = Math.min(fontScale, BAR_CONTROL_MAX_SCALE);
  const container = pillContainerWidth(windowWidth, slotWidth);
  const chrome = 2 * CONV.headPillPadX + leading + CONV.headPillGap;
  const secondaryWidth = estimateTextWidth(secondary, font.meta, scale);
  const nameWidth = estimateTextWidth(name, font.heading, scale);
  const nameFloor = Math.min(nameWidth, PILL_NAME_FLOOR_CHARS * font.heading * scale);
  return container - chrome - CONV.headPillGap - secondaryWidth >= nameFloor;
}
