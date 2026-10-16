// =============================================================================
// 행동 승인 카드의 행 중 **한 줄만 클라이언트가 강조하는 것** (#3729)
//
// 행 이름과 값은 서버가 정한다(ADR-0186 부록 A, `channel_create_rows`). 클라이언트는
// 그 문장을 다시 짓지 않는다 — 한 가지만 빼고: `channel.create`의 「이 에이전트도
// 참여」가 「예」일 때다. 이 행은 다른 행과 성질이 다르다. 나머지는 **무엇을 만드는가**
// 이고 이것은 **누가 더 볼 수 있게 되는가**다: 채널을 만든 에이전트가 그 채널의
// 멤버가 되면 에이전트의 접근 범위가 승인 채널 하나만큼 넓어진다(증보 V3).
//
// 판정은 행 이름과 값의 첫 글자 두 가지에만 선다. 서버가 문구를 바꾸면 강조가 조용히
// 꺼지고 카드는 평범한 행으로 남는다 — 틀린 강조를 켜는 것보다 낫다(fail-closed).
// =============================================================================

export const AGENT_JOINS_ROW_LABEL = "이 에이전트도 참여";

/** 강조 행 밑에 붙는 한 줄. 서버 문장에 덧붙이는 것이지 대체가 아니다. */
export const ACCESS_WIDENING_NOTE =
  "이 에이전트가 새 채널에도 들어가요. 접근 범위가 넓어져요.";

export function isAccessWideningRow(
  actionId: string,
  row: { label: string; value: string }
): boolean {
  return (
    actionId === "channel.create" &&
    row.label === AGENT_JOINS_ROW_LABEL &&
    row.value.startsWith("예")
  );
}

// -----------------------------------------------------------------------------
// 워크스페이스 전체에 걸리는 행동 (ADR-0201 증보 v2 H6-1, #3893)
//
// 도우미가 이제 워크스페이스 설정(문구·링크 미리보기·팀 기억 끄기/멈춤·재개 정책)도 카드로
// 올린다. 서버 행은 「무엇이 → 무엇으로」를 말하고, 이 한 줄은 **누구에게 닿는가**를 말한다:
// 채널 하나, 에이전트 하나가 아니라 모든 멤버의 화면이 바뀐다. 판정은 액션 id 하나로 서고,
// 모르는 id는 줄을 세우지 않는다(fail-closed).
// -----------------------------------------------------------------------------

const WORKSPACE_WIDE_ACTIONS: ReadonlySet<string> = new Set([
  "workspace.settings.update",
  "workspace.unfurl.update",
  "workspace.memory.update",
  "workspace.work_tier.update",
]);

export const WORKSPACE_WIDE_LABEL = "적용 범위";
export const WORKSPACE_WIDE_VALUE = "워크스페이스 전체";
export const WORKSPACE_WIDE_NOTE = "승인하면 모든 멤버에게 바로 적용돼요.";

export function isWorkspaceWideAction(actionId: string): boolean {
  return WORKSPACE_WIDE_ACTIONS.has(actionId);
}
