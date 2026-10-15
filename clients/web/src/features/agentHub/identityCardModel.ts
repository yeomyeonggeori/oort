import { ApiError, type MembershipRole, type RosterMember } from "@momo/core/lib/api";
import { uuidEq } from "@momo/core/lib/api";

// 에이전트 프로필 카드의 판정 (#3821, #3729 흡수). 화면은 이 두 함수의 답만 그린다.

/**
 * 이름을 바꿀 수 있는 사람: 그 에이전트의 소유자이거나 워크스페이스 owner/admin.
 * 서버(`PATCH /agents/{agent}`, ADR-0186 증보 V4)와 같은 판정이다. 사람만이다. 서버가
 * 최종 판정이므로 이것은 버튼을 보일지 정하는 것일 뿐 권한의 근거가 아니다.
 */
export function canEditAgentIdentity(
  viewer: { id: string; kind: "human" | "agent"; role: MembershipRole | undefined },
  agent: Pick<RosterMember, "ownerHumanId">
): boolean {
  if (viewer.kind !== "human") return false;
  if (viewer.role === "owner" || viewer.role === "admin") return true;
  return uuidEq(agent.ownerHumanId, viewer.id);
}

export const RENAME_FALLBACK_ERROR =
  "이름을 바꾸지 못했어요. 연결을 확인하고 다시 시도해 주세요.";

/** 서버 거절을 해요체 한 문장으로. 서버 문장은 영어이므로 상태로 갈라 말한다. */
export function renameErrorCopy(error: unknown): string {
  if (!(error instanceof ApiError)) return RENAME_FALLBACK_ERROR;
  switch (error.status) {
    case 400:
      return "이름은 비어 있지 않아야 하고 100자를 넘을 수 없어요. 다시 적어 주세요.";
    case 403:
      return "이 에이전트의 소유자나 관리자만 이름을 바꿀 수 있어요.";
    case 404:
      return "에이전트를 찾을 수 없어요. 목록을 새로 고친 뒤 다시 시도해 주세요.";
    case 409:
      return "다른 멤버가 쓰고 있거나 비슷해 보이는 이름이에요. 다른 이름으로 적어 주세요.";
    default:
      return RENAME_FALLBACK_ERROR;
  }
}

/** 입력이 저장할 만한 변경인가: 앞뒤 공백을 걷은 값이 비지 않고 현재 이름과 달라야 한다. */
export function renameDraftState(
  draft: string,
  current: string
): { name: string; savable: boolean } {
  const name = draft.trim();
  return { name, savable: name !== "" && name !== current.trim() };
}
