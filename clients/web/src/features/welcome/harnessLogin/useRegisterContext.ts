import { useMemo } from "react";
import { agentPortEndpoint } from "@momo/core/features/hostedAgents/presets";
import { registerSubscriptionAgent } from "@momo/core/features/hostedAgents/api";
import { useSession } from "@/app/session";
import { SUBSCRIPTION_REGISTER_BUILD_FLAG } from "@/lib/env";
import { absoluteApiBase } from "@/lib/serverBase";
import { agentPortConnect, agentPortDevice } from "@/lib/tauri";
import { useSubscriptionEntryState } from "../SubscriptionAgentEntry";
import type { RegisterContext } from "./RegisterStepBody";
import type { SubscriptionEntryState } from "../SubscriptionAgentEntry";

/**
 * 로그인 뒤 등록 단계를 세울 수 있는가(#3567). 빌드 플래그가 꺼져 있으면(기본) 입구 상태와
 * 무관하게 아니다: D15 `register`도 CLI `add-json`도 이 경로에서만 불리므로, 맥락이 null이면
 * 두 호출 모두 일어나지 않는다.
 */
export function registerSurfaceEligible(
  buildFlagOn: boolean,
  entry: SubscriptionEntryState
): boolean {
  return buildFlagOn && (entry === "rows" || entry === "server-off");
}

/**
 * 「로그인 뒤 에이전트로 만들기」를 낼 수 있는 자리에서만 맥락을 돌려준다(#3389).
 * 데스크탑이고, 이 멤버가 에이전트를 만들 수 있고(소유자·관리자), 빌드가 구독 표면을
 * 걷지 않았을 때다. 서버가 꺼져 있어도(`server-off`) 맥락을 준다: 숨기지 않고 모달이
 * 「이 서버에서는 꺼져 있어요」를 차분히 말해야 한다. 그 밖(웹, 일반 멤버)은 null이라
 * 로그인 모달은 예전처럼 「연결됐어요」에서 닫힌다.
 */
export function useRegisterContext(): RegisterContext | null {
  const { workspaceId, session } = useSession();
  const entry = useSubscriptionEntryState();
  const eligible = registerSurfaceEligible(SUBSCRIPTION_REGISTER_BUILD_FLAG, entry);
  const handle = session.member.handle;
  return useMemo(
    () =>
      eligible
        ? {
            memberHandle: handle,
            onOpenAgents: () => {
              window.location.hash = "#/agents";
            },
            deps: {
              register: (body) => registerSubscriptionAgent(workspaceId, body),
              device: agentPortDevice,
              connect: agentPortConnect,
              endpoint: () => agentPortEndpoint(absoluteApiBase()),
            },
          }
        : null,
    [eligible, handle, workspaceId]
  );
}
