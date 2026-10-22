// 자리표시 (AP-1a #4186): 글자 크기(작게·기본·크게).
// 자리: 카드 「대화 표시」 맨 위. 소유: AP-2a(#4189).
//
// 지금은 아무것도 그리지 않는다. 컨트롤은 앱이 그 값을 **실제로 따를 때**, 곧 소비자 규칙이 같은
// PR에 들어올 때만 연다(ADR-0189 증보 1 「눌러도 안 바뀌는 컨트롤은 먼저 내보내지 않는다」).
// 소유 이슈는 이 파일만 채우고, 값은 `@/design/theme`의 `updateAppearance`·`useAppearance`로
// 저장·구독한다. 합성하는 쪽(이 행을 부르는 카드)은 건드리지 않는다.

/**
 * 소유 이슈가 이 행을 열 때 `true`로 바꾼다(컴포넌트를 채우는 같은 PR에서). 열린 행은 슬롯 시험의
 * 「아무것도 안 그린다」 단정에서 빠지고, 이 행을 부르는 합성 쪽 파일은 고치지 않는다.
 */
export const FONT_SIZE_ROW_OPEN: boolean = false;

export function FontSizeRow(): null {
  return null;
}
