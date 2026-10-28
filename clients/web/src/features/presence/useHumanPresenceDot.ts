import type { RosterMember } from "@momo/core/lib/api";
import {
  humanPresenceDot,
  withOwnConnection,
  type StatusDot,
} from "@momo/core/features/presence/statusDot";
import { useSession } from "@/app/session";
import { useNowMsForExpiry } from "@/features/sidebar/useCustomStatusView";

// =============================================================================
// 사람 한 명의 상태 점 (#4692). 판정은 코어의 `humanPresenceDot`(선언 상태 > 접속 여부, 모르면 점 없음)
// 한 함수이고, 이 훅이 가져다 넣는 것은 둘이다:
//   - 방해 금지 만료 시각의 시계(`useNowMsForExpiry`: 만료 순간에 한 번 다시 그린다)
//   - **보는 사람 자기 행**의 접속 여부 = 이 클라이언트 자신의 연결(`withOwnConnection`). 남의 행은 서버의
//     `online` 그대로다.
// 에이전트에게는 점이 없다(ADR-0160 D4: 에이전트의 생존감은 서버의 생존 판정이고, 그 칩이 따로 있다).
//
// 훅과 컴포넌트를 한 파일이 함께 내보내면 빠른 새로고침이 깨지므로 컴포넌트는 `HumanPresence.tsx` 에 있다.
// =============================================================================

export function useHumanPresenceDot(member: RosterMember | null): StatusDot | null {
  const { session, connStatus } = useSession();
  const nowMs = useNowMsForExpiry(member?.dndUntilMs);
  if (member === null || member.kind !== "human") return null;
  return humanPresenceDot(
    withOwnConnection(member, session.member.id, connStatus === "connected"),
    nowMs
  );
}
