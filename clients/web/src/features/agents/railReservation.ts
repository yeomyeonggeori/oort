import type { RosterMember } from "@momo/core/lib/api";
import type { Directory } from "@/features/workspace/useWorkspace";

// =============================================================================
// 입력창 레일 칸을 **미리 잡을지**의 판정 (#4619 planner 결정 4). 컴포넌트 파일(`ActivityRail.tsx`)과 떼어 둔 것은 이 파일이
// 순수 함수뿐이기 때문이다(컴포넌트 파일이 함수를 함께 내보내면 빠른 새로고침이 그 파일을 통째로 다시 읽는다).
// =============================================================================

/** 에이전트가 이 채널의 활동 멤버인가(레일 칸을 미리 잡을지 정한다). */
export function channelHasAgent(directory: Directory, channelId: string): boolean {
  const key = channelId.toLowerCase();
  return directory.members.some(
    (member) =>
      member.kind === "agent" &&
      member.status === "active" &&
      member.channelIds.some((id) => id.toLowerCase() === key)
  );
}

/**
 * 이 대화가 레일 칸을 **미리 잡는가** (#4619 planner 결정 4). 에이전트가 있는 대화에서만이다: 에이전트 DM이거나, 활동
 * 중인 에이전트 멤버가 이 채널에 있을 때. 사람만 있는 대화는 칸도 없고 입력창 위 간격은 #1749대로 폼의 윗 여백뿐이다
 * (죽은 세로 띠가 없다). 에이전트가 들어오고 나갈 때 이 값이 바뀌는 것은 허용한다: 대화가 바뀌는 시점이라 줄이
 * 서고 지며 타임라인을 미는 흔들림이 아니다.
 */
export function isRailReserved(options: {
  dmAgent: Pick<RosterMember, "kind"> | null;
  directory: Directory;
  channelId: string;
}): boolean {
  return options.dmAgent !== null || channelHasAgent(options.directory, options.channelId);
}
