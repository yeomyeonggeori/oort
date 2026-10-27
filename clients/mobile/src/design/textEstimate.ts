// =============================================================================
// 한 줄 글의 폭 어림 (#4319) — Jest 에는 글자 측정이 없고 실제 폭은 기기의 글꼴이 정한다.
//
// 「한 줄에 이 글이 다 들어가는가」를 렌더 전에 정해야 하는 자리(프로필 시트의 행동 타일 라벨, 대화 머리 알약의 보조 글)가 같은 어림을
// 쓴다. **넉넉한 쪽으로** 어린다 — 한 줄을 덜 쓰는 것(타일을 쌓거나 보조 글을 숨김)이 글이 잘리는 것보다 싸다. 한글 한 음절은 글자
// 크기만큼(1em), 공백은 0.3em, 그 밖(영문·숫자·기호)은 0.6em 이다.
// =============================================================================

/** 한글 음절 한 글자의 폭(em). */
export const HANGUL_EM = 1;
/** 공백의 폭(em). */
export const SPACE_EM = 0.3;
/** 한글 음절·공백이 아닌 글자의 폭(em) — 영문·숫자·기호. */
export const OTHER_EM = 0.6;

const HANGUL_SYLLABLE = /[가-힣]/;

/** `text` 의 폭(em) — 글자 크기·배율을 곱하기 전. */
export function textEm(text: string): number {
  let em = 0;
  for (const char of text) {
    em += HANGUL_SYLLABLE.test(char) ? HANGUL_EM : char === ' ' ? SPACE_EM : OTHER_EM;
  }
  return em;
}

/** `text` 가 글자 크기 `pt`·글자 배율 `fontScale` 에서 한 줄로 차지하는 폭(pt)의 어림. */
export function estimateTextWidth(text: string, pt: number, fontScale: number): number {
  return textEm(text) * pt * fontScale;
}
