// =============================================================================
// 입력창 위 라우팅 자리에 무엇이 서는가 (AIH-9, #3439).
//
// 정확히 하나만 선다. 부른 에이전트가 전부 답하지 않는 글에서는 「이번만 바꾸기」 줄도 빈
// 예약 띠도 아니라 경고 줄이 그 자리를 직접 차지한다(띠와 경고를 둘 다 그리면 빈 띠 하나와
// 구분선 둘이 생긴다).
// =============================================================================

export type ComposerRoutingSlot = "bar" | "reserved" | "warning" | "none";

export function composerRoutingSlot({
  hasTarget,
  noneAnswer,
  rowReserved,
  hasNotice,
}: {
  hasTarget: boolean;
  noneAnswer: boolean;
  rowReserved: boolean;
  hasNotice: boolean;
}): ComposerRoutingSlot {
  if (noneAnswer && hasNotice) return "warning";
  if (hasTarget) return "bar";
  return rowReserved ? "reserved" : "none";
}
