// =============================================================================
// 포인터가 마지막으로 있던 자리 (#3963, design-review R4 마이크로 델타 H).
//
// 호버 X 는 포인터가 행에 **들어올 때** 선다(`mouseenter`). 그런데 행이 포인터를 그 위에 둔 채 「닫을 수 있음」으로
// 바뀌는 길이 있다: 안 읽음 DM 의 알약을 눌러 열면 읽는 중이라 안 읽음이 0 으로 접히고, 그 순간 X 가 알약이 있던
// 바로 그 자리에 서게 된다. 그 클릭의 꼬리 - 더블클릭의 둘째 클릭 - 가 방금 뜬 X 를 누르면 읽으려고 연 DM 이 열자마자
// 닫힌다. 그래서 **그런 길에서는 포인터가 움직인 뒤에야 X 를 세운다**. 얼마나 움직였는가를 재려면 움직이기 전에 포인터가
// 어디 있었는지를 알아야 하고, 그것을 알려 주는 브라우저 API 는 없다(이벤트가 올 때만 안다). 그래서 문서 전체의
// `mousemove` 를 한 번만 듣는 아주 작은 기록을 둔다: 좌표 두 개를 덮어쓸 뿐이고 아무것도 렌더하지 않는다.
// =============================================================================

let atX = Number.NaN;
let atY = Number.NaN;
let installed = false;

/** 문서 전체의 `mousemove` 를 듣기 시작한다(한 번만). 포털 메뉴 위의 포인터도 같은 문서의 이벤트라 놓치지 않는다. */
export function ensurePointerTrail(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener(
    "mousemove",
    (event) => {
      atX = event.clientX;
      atY = event.clientY;
    },
    { capture: true, passive: true }
  );
}

/** 마지막으로 알려진 포인터의 뷰포트 좌표. 아직 한 번도 못 봤으면 `null`. */
export function lastPointerAt(): { x: number; y: number } | null {
  return Number.isNaN(atX) || Number.isNaN(atY) ? null : { x: atX, y: atY };
}

/** 시험이 「포인터를 본 적 없음」에서 시작하게 한다. */
export function resetPointerTrailForTest(): void {
  atX = Number.NaN;
  atY = Number.NaN;
}
