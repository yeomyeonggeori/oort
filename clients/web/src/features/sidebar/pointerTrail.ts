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
// 「포인터가 다음에 움직일 때」를 기다리는 호출들(#5191). 새 이벤트 리스너를 더 달지 않고 아래 하나가 부른다.
const nextMoveWatchers = new Set<() => void>();

/** 문서 전체의 `mousemove` 를 듣기 시작한다(한 번만). 포털 메뉴 위의 포인터도 같은 문서의 이벤트라 놓치지 않는다. */
export function ensurePointerTrail(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener(
    "mousemove",
    (event) => {
      atX = event.clientX;
      atY = event.clientY;
      if (nextMoveWatchers.size === 0) return;
      // 한 번씩만 부른다. 복사해서 비운 뒤 부르므로, 부르는 중에 다시 건 호출은 그다음 이동을 기다린다.
      const due = [...nextMoveWatchers];
      nextMoveWatchers.clear();
      for (const watcher of due) watcher();
    },
    { capture: true, passive: true }
  );
}

/**
 * 포인터가 **다음에** 움직일 때 한 번 부른다(#5191). 풀어 주는 함수를 돌려준다.
 *
 * 브라우저의 `:hover` 와 `mouseleave` 는 포인터 밑 요소가 가만히 있는 포인터 밑에서 사라지면(눌렀던 메뉴 항목이 닫히고, 편집기가
 * 저장으로 사라지고) 낡은 채 남는다 — WebKit 은 다음 포인터 이동의 hit-test 때까지 옛 값을 쥐고, 그 요소를 거쳐 가던 `mouseleave` 는
 * 이 요소의 조상에 닿지 않는다. 「다음 이동」은 그 값이 바로잡히는 가장 이른 때라서, 그때 한 번 다시 읽으려는 호출이 이것을 쓴다.
 */
export function onNextPointerMove(callback: () => void): () => void {
  ensurePointerTrail();
  nextMoveWatchers.add(callback);
  return () => {
    nextMoveWatchers.delete(callback);
  };
}

/** 마지막으로 알려진 포인터의 뷰포트 좌표. 아직 한 번도 못 봤으면 `null`. */
export function lastPointerAt(): { x: number; y: number } | null {
  return Number.isNaN(atX) || Number.isNaN(atY) ? null : { x: atX, y: atY };
}

/** 시험이 「포인터를 본 적 없음」에서 시작하게 한다. */
export function resetPointerTrailForTest(): void {
  atX = Number.NaN;
  atY = Number.NaN;
  nextMoveWatchers.clear();
}
