import {font, SAFE_GUTTER, space} from '../../design/tokens';

// =============================================================================
// 프로필 시트의 행동 타일 — 한 줄에 라벨이 안 잘리고 들어가는가 (#4319).
//
// 타일(`ActionTile`)의 라벨은 `numberOfLines={1}` 이고 글자 배율 상한이 없다. 에이전트의 세 타일(메시지 보내기·멘션 복사·에이전트
// 정보)은 작은 화면·큰 글씨에서 나란히 서면 라벨이 「메시지 보…」로 잘린다 — 라벨은 이 타일의 **이름**이라 잘리면 무엇을 누르는지
// 모른다. 그래서 라벨이 한 줄에 다 들어가지 않으면 타일을 **한 줄씩 쌓는다**(폭 전체를 쓴다). iOS 접근성 레이아웃과 같은 처방이고
// `ListRow` 의 값이 제목 아래로 내려오는 것(`STACK_PILL_SCALE`)과 같은 모양이다.
//
// 글자 폭은 어림이다(Jest 에는 글자 측정이 없고 실제 폭은 기기의 글꼴이 정한다). **넉넉한 쪽으로** 어린다 — 한 줄을 덜 쓰는 것이
// 라벨이 잘리는 것보다 싸다. 한글 한 음절은 글자 크기만큼(1em), 공백은 0.3em, 그 밖(영문·숫자·기호)은 0.6em 이다.
// =============================================================================

/** 한글 음절 한 글자의 폭(em). */
const HANGUL_EM = 1;
/** 공백의 폭(em). */
const SPACE_EM = 0.3;
/** 한글 음절·공백이 아닌 글자의 폭(em) — 영문·숫자·기호. */
const OTHER_EM = 0.6;

const HANGUL_SYLLABLE = /[가-힣]/;

/** 타일 라벨(`font.label`, 굵게)이 `fontScale` 에서 차지하는 폭(pt)의 어림. */
export function tileLabelWidth(label: string, fontScale: number): number {
  let em = 0;
  for (const char of label) {
    em += HANGUL_SYLLABLE.test(char) ? HANGUL_EM : char === ' ' ? SPACE_EM : OTHER_EM;
  }
  return em * font.label * fontScale;
}

/** 라벨이 타일 가장자리에 붙지 않게 양쪽에 남기는 숨(pt). 타일은 가로 여백이 없다. */
const TILE_EDGE = space.xs;

/**
 * 타일들이 한 줄에 라벨을 다 보이며 나란히 서는가. 거짓이면 호출하는 쪽이 한 줄씩 쌓는다.
 * 타일이 하나이면 폭 전체를 쓰므로 늘 참이다(쌓아도 더 나아지지 않는다).
 */
export function tilesFitInRow(
  labels: readonly string[],
  windowWidth: number,
  fontScale: number,
): boolean {
  if (labels.length <= 1) return true;
  const tileWidth =
    (windowWidth - 2 * SAFE_GUTTER - (labels.length - 1) * space.sm) / labels.length;
  const widest = Math.max(...labels.map(label => tileLabelWidth(label, fontScale)));
  return widest + 2 * TILE_EDGE <= tileWidth;
}
