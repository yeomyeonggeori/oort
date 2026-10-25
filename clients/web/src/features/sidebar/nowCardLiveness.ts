import { isUntakenHumanRun } from "@momo/core/features/agents/runWaiting";
import type { AgentWorkingSignal } from "@/features/agents/agentWorkingSignal";
import { openTurns } from "./SidebarNowCard";

/**
 * 작업 중 카드가 아무도 가져가지 않은 사람 요청을 말하면 그 에이전트의 id, 아니면 null (#4285).
 * 사이드바가 이 에이전트의 서버 생존 판정(D4)을 읽어 카드에 `liveness`로 넘긴다. 카드는 읽지 않고
 * 받으므로 쿼리·세션 없이 그려진다. 카드와 같은 `openTurns`를 쓰므로 둘이 다른 에이전트를 가리킬 수 없다.
 */
export function nowCardWaitingAgentId(
  signals: ReadonlyMap<string, AgentWorkingSignal>,
  nowMs: number
): string | null {
  const lead = openTurns(signals, nowMs)[0];
  return lead !== undefined && isUntakenHumanRun(lead.server) ? lead.memberId : null;
}
