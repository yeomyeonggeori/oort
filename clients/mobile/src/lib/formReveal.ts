// =============================================================================
// 폼에서 포커스한 칸을 키보드 위로 — 어디까지 굴리는가 (#2678)
//
// 키보드는 창을 줄일 뿐 목록을 굴리지 않는다. 줄어든 창 안에서 포커스한 칸이 어디
// 있는지는 목록이 모르고, UIKit 이 포커스 순간에 스스로 굴리는 것은 캐럿 한 줄까지다
// (iPhone 13 mini · Release 실측: 비밀번호 칸 3pt, AX1 이메일 칸 12pt 가 그 뒤에도
// 가려졌다). 그래서 폼이 직접 정한다 — 이 함수가 그 한 줄짜리 셈이다.
//
// 규칙은 둘이다.
//
//   1. **포커스한 칸은 언제나 온전히 보인다.** 키보드가 닿는 칸을 눈이 못 보면 그것이
//      ADR-0112 D6 의 Blocker 부류다.
//   2. **주 버튼은 칸과 함께 창에 들 때 함께 보인다.** 칸에서 버튼까지(여백 포함)가
//      창에 들면 그 전체가 들도록 **가장 적게** 굴린다 — 이미 보이면 굴리지 않는다.
//      들지 않으면 칸을 창 맨 위에 둔다: 칸 아래로 들어가는 만큼(다음 칸부터) 보인다.
//
// 모든 값은 **콘텐츠 좌표**다: 행의 `onLayout` y(목록 콘텐츠의 직계 행이다), 목록의
// 자기 높이(`onLayout` — 키보드가 줄인 창), 목록의 오프셋(`onScroll`). 키보드 좌표는
// 어디에도 없다 — 창을 줄이는 것은 이 셈의 몫이 아니다(연결 화면에서는
// `KeyboardAvoidingView`). 그래서 좌표계를 맞출 일도 없다.
// =============================================================================

/** 콘텐츠 좌표의 세로 구간. */
export interface RevealSpan {
  top: number;
  bottom: number;
}

export interface RevealInput {
  /** 목록의 창 높이 — 키보드가 줄인 뒤의 값. 0 이면 아직 재지 않았다. */
  viewport: number;
  /** 지금 오프셋. */
  offset: number;
  /** 포커스한 칸(라벨부터 칸 아래 힌트까지 한 행). 없으면 굴릴 것도 없다. */
  field: RevealSpan | undefined;
  /** 주 버튼. 칸보다 아래에 있을 때만 함께 보인다. */
  action?: RevealSpan;
  /** 창 가장자리와 띄울 거리 — 폼의 행 간격과 같게 둔다. */
  margin: number;
}

/**
 * 가야 할 오프셋. 굴릴 필요가 없거나 셈할 수 없으면 `null`.
 *
 * 위로의 clamp(0)만 여기서 한다. 끝으로의 clamp 는 스크롤뷰가 한다 — JS 의
 * `scrollTo` 는 네이티브에서 콘텐츠 끝으로 잘린다.
 */
export function formRevealOffset({
  viewport,
  offset,
  field,
  action,
  margin,
}: RevealInput): number | null {
  if (viewport <= 0 || field === undefined) return null;
  const top = field.top - margin;
  const bottom =
    (action !== undefined && action.bottom > field.bottom ? action.bottom : field.bottom) +
    margin;
  let next = offset;
  if (bottom - top <= viewport) {
    if (bottom > next + viewport) next = bottom - viewport;
    if (top < next) next = top;
  } else {
    next = top;
  }
  next = Math.max(0, next);
  return Math.abs(next - offset) < 1 ? null : next;
}
