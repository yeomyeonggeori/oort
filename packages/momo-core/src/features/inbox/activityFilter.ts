import type { FilterTabsSpec } from "../common/filterTabs";
import type { FeedItem } from "./model";

// =============================================================================
// 활동 필터 칩 (#3337, 사이드바·알림 시안 §1.1·§6-2). 순수.
//
// 활동 = 워크스페이스 전체에서 일어난 일의 기록이다. 읽음도 수도 없다(그래서 칩에
// 개수를 달지 않는다: 수가 붙는 순간 「처리할 것」으로 읽혀 인박스와 역할이 섞인다).
// 칩은 보는 범위만 좁힌다.
//   전체          : 모두
//   내 에이전트    : 내가 담당하는 에이전트의 행(ADR-0131). 원천 쪽에서 좁힌다.
//   승인          : 승인 원장 행(대기·결정 끝)
//   작업 끝남      : 끝난 작업 실행 기록(진행 중인 실행은 아직 끝난 일이 아니다)
// =============================================================================

export type ActivityFilter = "all" | "mine" | "approvals" | "done";

export const ACTIVITY_FILTERS: readonly ActivityFilter[] = [
  "all",
  "mine",
  "approvals",
  "done",
];

const LABELS: Record<ActivityFilter, string> = {
  all: "전체",
  mine: "내 에이전트",
  approvals: "승인",
  done: "작업 끝남",
};

export function activityFilterLabel(filter: ActivityFilter): string {
  return LABELS[filter];
}

export function parseActivityFilter(raw: string | null): ActivityFilter {
  return ACTIVITY_FILTERS.includes(raw as ActivityFilter)
    ? (raw as ActivityFilter)
    : "all";
}

/**
 * 칩이 행을 통과시키는가. `mine`은 여기서 걸지 않는다: 담당 판정은 디렉터리가 있는
 * 피드 원천(`useAgentFeed({ownedBy})`)이 갖고, 이 함수는 행의 종류만 본다.
 */
export function matchesActivityFilter(
  item: FeedItem,
  filter: ActivityFilter
): boolean {
  if (filter === "approvals") return item.kind === "approval";
  if (filter === "done") return item.kind === "run" && !item.pending;
  return true;
}

export const ACTIVITY_FILTER_TABS: FilterTabsSpec<ActivityFilter> = {
  label: "활동 필터",
  values: ACTIVITY_FILTERS,
  labelFor: activityFilterLabel,
  tabId: (f) => `activity-tab-${f}`,
  panelId: (f) => `activity-panel-${f}`,
  testId: (f) => `activity-tab-${f}`,
};
