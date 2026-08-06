import { useEffect, type RefObject } from "react";

// =============================================================================
// 덮인 표면을 탭 순서와 접근성 트리에서 함께 빼낸다.
//
// `inert` 는 플랫폼 자신의 답이다: 포커스 가능성과 보조기술 노출을 한 번에
// 없앤다. 이것이 곧 초점 트랩이기도 하다 — 덮인 쪽이 통째로 inert 이면 Tab 이 갈
// 수 있는 곳은 덮은 표면과 그 스크림뿐이라, 첫/마지막 요소를 추적하는 트랩을 손으로
// 구현할 이유가 없다. React 18 은 `inert` prop 을 알지 못하므로 속성으로 건다.
//
// 규칙이 이 파일에 따로 사는 이유는 **덮이는 쪽이 자기 노드를 이미 붙들고 있는
// 자리**가 있어서다: 작업 패널은 열릴 때 캐럿을 자기 안으로 들이려고 `aside` 의
// ref 를 갖고, 그 같은 노드가 관제 서랍에 덮이면 inert 여야 한다(design-review
// ADE 2단계 H1 ②). 셸이 대신 감싸는 <div> 를 세우면 그 상자가 패널의 기하
// (`work-panel-pane`)를 가져가므로, 노드가 아니라 규칙을 나눠 쓴다.
// =============================================================================

/** 이미 갖고 있는 ref 에 건다. */
export function useInertRefWhile<T extends HTMLElement>(
  ref: RefObject<T>,
  active: boolean
) {
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (active) node.setAttribute("inert", "");
    else node.removeAttribute("inert");
  }, [ref, active]);
}
