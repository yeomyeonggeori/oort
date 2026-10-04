import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentMembers } from "@momo/core/features/agents/hubModel";
import { mySubscriptionAgents, type MySubscriptionAgent } from "@momo/core/features/ai/aiHubModel";
import { useSession } from "@/app/session";
import { hostedListQuery } from "@/features/hostedAgents/hostedCredentialScope";
import { useDirectory } from "@/features/workspace/useWorkspace";

export type MySubscriptionAgentsRead =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ok"; agents: MySubscriptionAgent[] };

/**
 * 내가 만든 구독으로 쓰는 에이전트(서버 값). 명부와 호스티드 연결 목록, 개요 카드가 쓰는 같은
 * 쿼리다. 못 읽으면 `error`: 호출부는 「아직 에이전트 없음」이라 말하지 않는다.
 */
export function useMySubscriptionAgents(): MySubscriptionAgentsRead {
  const { workspaceId, session } = useSession();
  const directory = useDirectory(workspaceId);
  const hosted = useQuery(hostedListQuery(workspaceId));
  const memberId = session.member.id;
  const members = directory.directory.members;
  const connections = hosted.data;
  const agents = useMemo(
    () => (connections ? mySubscriptionAgents(agentMembers(members), connections, memberId) : []),
    [members, connections, memberId]
  );
  if (directory.isPending || hosted.isPending) return { state: "loading" };
  if (directory.isError || hosted.isError) return { state: "error" };
  return { state: "ok", agents };
}
