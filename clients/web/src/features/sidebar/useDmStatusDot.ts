import type { RosterMember } from "@momo/core/lib/api";
import {
  dmPeerStatusDot,
  type StatusDot,
} from "@momo/core/features/presence/statusDot";
import { useAgentLiveness } from "@/features/agents/useAgentLiveness";

// =============================================================================
// DM 상대 한 명의 상태 점 (#3964). 판정은 코어의 `dmPeerStatusDot` 한 함수이고, 이 훅이 하는 일은 에이전트의
// 생존 판정을 **가져다 넣는 것**뿐이다(`useAgentLiveness`: 쿼리 키가 폰과 같고, 같은 에이전트를 묻는 다른
// 표면과 한 요청을 나눠 쓴다). 사람에게는 쿼리가 서지 않는다.
//
// 이 훅을 부르는 컴포넌트가 둘이다 - 아바타(눈에 보이는 점, `DmAvatar`)와 행의 숨은 글(접근 가능한 이름,
// `DmStatusText`). 둘은 같은 쿼리를 읽으므로 같은 상태를 말한다. 컴포넌트는 `DmAvatar.tsx` 에 있다(이 파일은 훅만
// 내보낸다: 훅과 컴포넌트를 한 파일이 함께 내보내면 빠른 새로고침이 깨진다).
// =============================================================================

export function useDmStatusDot(
  member: RosterMember | null,
  mayAct: boolean,
  nowMs: number
): StatusDot | null {
  const agentId = member?.kind === "agent" ? member.id : null;
  const read = useAgentLiveness(agentId);
  return dmPeerStatusDot({
    member,
    liveness: agentId === null ? undefined : read.liveness,
    mayAct,
    nowMs: agentId === null ? nowMs : read.nowMs,
  });
}
