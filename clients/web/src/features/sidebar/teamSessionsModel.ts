import type { SharedWorkSession } from "@momo/core/lib/api";
import { uuidEq } from "@momo/core/lib/api";
import { isFinishedState } from "@momo/core/features/workbench/teamBoard";

export type TeamFilter = "all" | "mine" | "waiting";

export const TEAM_FILTER_LABEL: Readonly<Record<TeamFilter, string>> = {
  all: "전체",
  mine: "내 것",
  waiting: "응답 필요",
};

export function filterTeamSessions(
  items: readonly SharedWorkSession[],
  filter: TeamFilter,
  selfMemberId: string
): SharedWorkSession[] {
  const live = items.filter((i) => !isFinishedState(i.state));
  if (filter === "mine") return live.filter((i) => uuidEq(i.owner.memberId, selfMemberId));
  if (filter === "waiting") return live.filter((i) => i.state === "waiting");
  return live;
}
