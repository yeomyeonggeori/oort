import { fetchRoster } from "@momo/core/lib/api";
import { countActiveAgents } from "@/features/welcome/welcomeKickoff";
import { clearFirstAgentPending } from "@/features/welcome/firstAgentStore";

// =============================================================================
// 초대 가입 뒤 다음 화면 (ADR-0193 D7, #2810 OB2-4).
//
// 워크스페이스에 활성 에이전트가 이미 있으면 AI 연결을 건너뛰고 곧장 첫 대화(D5)로
// 간다. 없으면 AI 연결(지금은 `FirstAgentStage`, 뒤에 #2814)로 간다. 판정은 새 API
// 없이 클라가 이미 쓰는 디렉터리(`/roster`, ADR-0185 c1)로 한다.
//
// 모르면(디렉터리를 못 읽었으면) 지금 흐름 그대로 AI 연결을 남긴다. 틀린 건너뛰기는
// 에이전트 없는 팀을 조용한 첫 대화에 세우고, 틀린 남김은 한 화면을 더 보일 뿐이다.
// =============================================================================

export type AfterJoinSurface = "first-conversation" | "ai-connect";

export function afterJoinSurface(activeAgentCount: number | null): AfterJoinSurface {
  return activeAgentCount !== null && activeAgentCount > 0
    ? "first-conversation"
    : "ai-connect";
}

/**
 * 가입 세션으로 디렉터리를 한 번 읽고, 에이전트가 있으면 AI 연결 표지를 거둔다.
 * first-run 표지(`recordFreshSignupFirstRun`·`recordFirstRunPending`)를 찍은 **뒤에**
 * 부른다. 던지지 않는다.
 */
export async function settleAfterJoin(workspaceId: string): Promise<AfterJoinSurface> {
  let count: number | null = null;
  try {
    count = countActiveAgents(await fetchRoster(workspaceId));
  } catch {
    count = null;
  }
  const surface = afterJoinSurface(count);
  if (surface === "first-conversation") clearFirstAgentPending();
  return surface;
}
