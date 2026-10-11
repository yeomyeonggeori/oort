import { missingMemberLabel } from "@momo/core/features/workspace/directory";
import {
  actorToken,
  resolveActorNames,
  type ActorNames,
} from "@momo/core/features/inbox/model";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";

/**
 * 인박스에서 글쓴이를 푸는 **웹 쪽 유일한 입구**(#3694). 목록 줄(`useInbox`)과 오른쪽
 * 패널(`InboxDetail`)이 모두 여기를 지난다. 에이전트는 타임라인과 같이 `@핸들`로
 * 부른다(`MessageRow`의 작성자 줄) — 연결 이름(`displayName`)으로 갈라지지 않는다.
 */
export function actorNamesIn(
  directory: Directory,
  memberId: string,
): ActorNames {
  const member = memberFor(directory, memberId);
  const owner =
    member?.kind === "agent" ? memberFor(directory, member.ownerHumanId) : null;
  return resolveActorNames(
    member,
    missingMemberLabel(directory),
    owner?.displayName,
  );
}

export function actorLabelIn(directory: Directory, memberId: string): string {
  return actorToken(actorNamesIn(directory, memberId));
}
