import { ApiError, uuidEq, type MembershipRole, type RosterMember } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import type { MessageKey } from "../../i18n/generated/messages";

// =============================================================================
// 채널 멤버 패널의 「채널에서 내보내기」 (#5778).
//
// 서버 길은 `DELETE …/channels/{ch}/members/{member}`(`removeChannelMember`)이고 워크스페이스 소유자·관리자만 받는다.
// 이 파일은 **누구의 줄에 그 행동을 내놓는가**와 **거절을 어떤 문장으로 말하는가**만 정한다. 문장은 사전이 진다
// (`timeline.memberPanel.remove*`).
// =============================================================================

/**
 * 이 줄에 「채널에서 내보내기」를 내놓는가. 워크스페이스 정지·제거 사다리의 **거울**이다(ADR-0128 D2,
 * `workspace_authorization.rs` 의 `can_remove`): 보는 사람이 대상보다 높아야 한다.
 *
 * - 보는 사람은 소유자나 관리자다(서버: 그 밖의 역할은 403).
 * - 대상은 **사람**이고 자기 자신이 아니다. 나는 「채널 나가기」로 나가고, 에이전트는 에이전트 허브의 채널 배치가 다룬다.
 * - 소유자는 관리자·멤버·게스트를, 관리자는 멤버·게스트만. 같거나 높은 역할에는 내놓지 않는다.
 *
 * 역할을 모르는 대상(명부 투영이 `role` 을 못 실은 옛 서버)은 소유자에게만 열린다 — `canIssuePasswordReset` 과 같은
 * 규칙이다. 관리자는 대상이 멤버·게스트라고 **알 때만** 연다. 모름이 열림이 되지 않게 한다.
 */
export function canRemoveFromChannel(
  viewerRole: MembershipRole | undefined,
  viewerMemberId: string,
  target: Pick<RosterMember, "id" | "kind" | "role">
): boolean {
  if (viewerRole !== "owner" && viewerRole !== "admin") return false;
  if (target.kind !== "human") return false;
  if (uuidEq(viewerMemberId, target.id)) return false;
  if (viewerRole === "owner") return target.role !== "owner";
  return target.role === "member" || target.role === "guest";
}

/**
 * 서버가 내보내기를 받은 **뒤** 명부 캐시에 그 사실을 적는다(`withChannelMemberAdded` 의 반대). 확인 단계가 있는 파괴
 * 행동이라 먼저 지우지 않는다 — 줄이 먼저 사라지면 「내보내는 중」과 실패 문장이 설 자리가 없다.
 */
export function withChannelMemberRemoved(
  members: RosterMember[],
  channelId: string,
  memberId: string
): RosterMember[] {
  return members.map((member) => {
    if (!uuidEq(member.id, memberId)) return member;
    const channelIds = member.channelIds.filter((id) => !uuidEq(id, channelId));
    if (channelIds.length === member.channelIds.length) return member;
    return { ...member, channelIds, channelCount: Math.max(0, member.channelCount - 1) };
  });
}

export type ChannelMemberRemoveFailureKey = Extract<MessageKey, `timeline.memberPanel.removeError${string}`>;

/**
 * 내보내기가 거절됐을 때 확인 단계 안에서 하는 말(사전 키, `{reason}` 은 전송 계층의 문장).
 * 403 은 보는 사람의 역할이 그 사이 내려갔을 때, 404 는 대상이 이미 나갔거나 채널이 보관됐을 때다.
 */
export function channelMemberRemoveFailure(error: unknown): {
  key: ChannelMemberRemoveFailureKey;
  values?: { reason: string };
} {
  if (error instanceof ApiError) {
    if (error.status === 403) return { key: "timeline.memberPanel.removeErrorForbidden" };
    if (error.status === 404) return { key: "timeline.memberPanel.removeErrorNotFound" };
  }
  if (error instanceof NetworkError) {
    return { key: "timeline.memberPanel.removeErrorNetwork", values: { reason: error.message } };
  }
  return { key: "timeline.memberPanel.removeErrorGeneric" };
}
