import { useCallback, useState } from "react";
import { closestToolbarScrollContainer } from "./hoverToolbarModel";

// =============================================================================
// 대화 줄 안 단추의 툴팁 방향 (#5980): 「다른 반응 고르기」 · 파일 카드의 내려받기 · PDF 열기.
//
// 글 줄의 호버 도구(`MessageActions`의 `tipSide`)와 같은 물음이다: 위 알약이 가장 가까운 스크롤 칸의 윗변에 잘리는가 — 잘리면 아래로.
// 다만 그 도구의 답(`straddleBelow`)은 **막대**의 자리라 이 단추들에는 맞지 않는다. 이 단추들은 줄 안 본문 아래쪽에 있어서, 단추가
// 칸 맨 위 띠에 걸릴 때는 줄 윗변이 이미 칸 위로 한참 올라가 막대가 아래로 뒤집혀 있고(`straddleBelow` 참 → 도구의 툴팁은 위), 쉴 때는
// 막대가 위에 걸쳐 있어 그 답을 따르면 맨 아래 글에서 다시 아래로 서서 잘린다(#5965가 닫은 것). 막대는 가리킬 때만 서고 이웃 글자로도
// 뒤집힌다(#5179). 그래서 같은 판정을 **단추 자신의 상자**로 한다: 단추 윗변이 칸 윗변에서 알약 + 틈보다 가까우면 아래, 아니면 위.
//
// 언제 재는가: 가리킬 때와 초점이 올 때(툴팁이 열리는 같은 사건). 초점으로 칸이 단추를 끌어올 때(`scrollIntoView` 가까운 쪽)는 위에서
// 끌려온 단추가 칸 윗변에, 아래에서 끌려온 단추가 칸 아랫변에 서므로 끌려오기 전의 판정과 같은 쪽이 나온다.
// =============================================================================

export type RowTipSide = "top" | "bottom";

/** 위 알약에 필요한 높이: 알약 30 + 틈 4(#5980 검수 실측 — 잘린 높이 = 34 − 단추 윗변까지의 거리). */
export const ROW_TIP_ROOM = 34;

/** 단추 상자로 정한 방향. 스크롤 칸을 못 찾으면(줄 밖) 위. */
export function rowTipSide(trigger: HTMLElement): RowTipSide {
  const scroller = closestToolbarScrollContainer(trigger);
  if (scroller === null) return "top";
  const room = trigger.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  return room < ROW_TIP_ROOM ? "bottom" : "top";
}

/** 단추의 `onPointerEnter`·`onFocus`에 `probe`를 달고 `Tooltip`에 `side`를 넘긴다. 같은 사건에서 툴팁이 열리므로 첫 그림부터 맞는 쪽이다. */
export function useRowTipSide(): { side: RowTipSide; probe: (event: { currentTarget: HTMLElement }) => void } {
  const [side, setSide] = useState<RowTipSide>("top");
  const probe = useCallback((event: { currentTarget: HTMLElement }) => setSide(rowTipSide(event.currentTarget)), []);
  return { side, probe };
}
